import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import { DBusMenu } from './menu.js';


const ITEM_INTERFACE = 'org.kde.StatusNotifierItem';
const ICON_SIZE = 18;
const REFRESH_DELAY_MS = 50;
const RETRY_DELAY_MS = 1000;
const MAX_REFRESH_ATTEMPTS = 3;
const ICON_PROPERTIES = ['Status', 'IconThemePath', 'IconName', 'IconPixmap', 'AttentionIconName', 'AttentionIconPixmap'];
const GONE_ERRORS = [
    Gio.DBusError.SERVICE_UNKNOWN, Gio.DBusError.NAME_HAS_NO_OWNER, Gio.DBusError.UNKNOWN_OBJECT,
    Gio.DBusError.UNKNOWN_INTERFACE, Gio.DBusError.UNKNOWN_METHOD, Gio.DBusError.INVALID_ARGS,
];


const UncachedFileIcon = GObject.registerClass({
    Implements: [Gio.Icon],
}, class UncachedFileIcon extends Gio.EmblemedIcon {
    _init(path) {
        super._init({ gicon: new Gio.FileIcon({ file: Gio.File.new_for_path(path) }) });
    }

    vfunc_to_tokens() {
        return [false, [], 0];
    }
});

function getBestPixmap(pixmaps, size) {
    const valid = [];

    for (let i = 0; i < (pixmaps?.n_children() ?? 0); i++) {
        const pixmap = pixmaps.get_child_value(i);
        const width = pixmap.get_child_value(0).get_int32();
        const height = pixmap.get_child_value(1).get_int32();
        const data = pixmap.get_child_value(2);

        if (width > 0 && height > 0 && data.n_children() >= width * height * 4)
            valid.push({ width, height, data });
    }

    valid.sort((a, b) => a.width * a.height - b.width * b.height);
    return valid.find(({ width, height }) => width >= size && height >= size) ?? valid.at(-1);
}


export const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(name, owner, path, logger) {
        super._init(0.5, name);
        this._clickGesture.set_enabled(false);

        this._name = name;
        this._path = path;
        this._logger = logger;
        this._properties = {};
        this._cancellable = new Gio.Cancellable();
        this._refreshId = 0;
        this._refreshSerial = 0;
        this._refreshFailures = 0;
        this._clickId = 0;
        this._lastClick = null;
        this._scrollX = 0;
        this._scrollY = 0;
        this._supportsActivation = true;

        this._icon = new St.Icon({
            style_class: 'system-status-icon',
            icon_size: ICON_SIZE,
            fallback_icon_name: 'image-loading-symbolic',
        });
        this._icon.connect('resource-scale-changed', () => this._updateIcon());

        this._label = new St.Label({ y_align: Clutter.ActorAlign.CENTER, visible: false });

        const box = new St.BoxLayout({ style_class: 'panel-status-indicators-box' });
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);
        this.visible = false;

        this._dbusMenu = new DBusMenu(name, owner, this.menu, logger,
            timestamp => this._provideActivationToken(timestamp));

        this._signalId = Gio.DBus.session.signal_subscribe(owner, null, null, path, null,
            Gio.DBusSignalFlags.NONE, (_bus, _sender, _path, iface) => {
                if (iface === ITEM_INTERFACE || iface === 'org.freedesktop.DBus.Properties')
                    this._queueRefresh();
            });

        this._watchId = Gio.DBus.session.watch_name(name, Gio.BusNameWatcherFlags.NONE,
            (_bus, _name, nameOwner) => {
                if (nameOwner !== owner)
                    this.destroy();
            },
            () => this.destroy());

        this._queueRefresh(0);
    }

    _onDestroy() {
        this._destroyed = true;
        this._cancellable.cancel();
        Gio.DBus.session.signal_unsubscribe(this._signalId);
        Gio.DBus.session.unwatch_name(this._watchId);

        if (this._refreshId)
            GLib.Source.remove(this._refreshId);
        if (this._clickId)
            GLib.Source.remove(this._clickId);

        this._dbusMenu.destroy();
        super._onDestroy();
    }

    refresh() {
        this._queueRefresh(0);
    }

    _queueRefresh(delay = REFRESH_DELAY_MS) {
        if (this._refreshId)
            return;

        this._refreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._refreshId = 0;
            this._refresh().catch(e => this._logger.error(`Could not update ${this._name}:`, e));
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refresh() {
        const serial = ++this._refreshSerial;
        let reply;

        try {
            reply = await Gio.DBus.session.call(this._name, this._path,
                'org.freedesktop.DBus.Properties', 'GetAll', new GLib.Variant('(s)', [ITEM_INTERFACE]),
                new GLib.VariantType('(a{sv})'), Gio.DBusCallFlags.NONE, -1, this._cancellable);
        } catch (e) {
            if (this._destroyed || e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;

            if (++this._refreshFailures < MAX_REFRESH_ATTEMPTS) {
                this._queueRefresh(RETRY_DELAY_MS);
            } else if (GONE_ERRORS.some(code => e.matches?.(Gio.DBusError, code))) {
                this._logger.warn(`Removing ${this._name}${this._path}: ${e.message}`);
                this.destroy();
            }
            return;
        }

        if (this._destroyed || serial !== this._refreshSerial)
            return;

        this._refreshFailures = 0;
        this._update(reply.get_child_value(0).deepUnpack());
    }

    _update(properties) {
        const previous = this._properties;
        this._properties = properties;

        const changed = name => {
            const [before, after] = [previous[name], properties[name]];
            return before && after ? !before.equal(after) : before !== after;
        };

        if (ICON_PROPERTIES.some(changed))
            this._updateIcon();

        if (changed('Menu')) {
            const menuPath = this._getString('Menu');
            this._dbusMenu.setPath(GLib.Variant.is_object_path(menuPath ?? '') && menuPath !== '/NO_DBUSMENU'
                ? menuPath : null);
        }

        const label = this._getString('XAyatanaLabel');
        this._label.text = label ?? '';
        this._label.visible = !!label;

        this.accessible_name = this._getString('IconAccessibleDesc') || label || this._getString('Title') || '';
        this.visible = this._getString('Status') !== 'Passive';
    }

    _getString(name) {
        const value = this._properties[name];
        return ['s', 'o'].includes(value?.get_type_string()) ? value.unpack() : null;
    }

    _getPixmaps(name) {
        const value = this._properties[name];
        return value?.get_type_string() === 'a(iiay)' && value.n_children() ? value : null;
    }

    _updateIcon() {
        const needsAttention = this._getString('Status') === 'NeedsAttention'
            && !!(this._getString('AttentionIconName') || this._getPixmaps('AttentionIconPixmap'));
        const prefix = needsAttention ? 'AttentionIcon' : 'Icon';
        const name = this._getString(`${prefix}Name`);
        const scale = Math.max(1, Math.ceil(this._icon.get_resource_scale()));

        this._icon.gicon = name
            ? this._createNamedIcon(name, scale)
            : this._createPixmapIcon(this._getPixmaps(`${prefix}Pixmap`), ICON_SIZE * scale);
    }

    _createPixmapIcon(pixmaps, size) {
        const pixmap = getBestPixmap(pixmaps, size);
        if (!pixmap)
            return null;

        const { width, height, data } = pixmap;
        if (this._pixmapIcon?.preferred_width !== width || this._pixmapIcon.preferred_height !== height)
            this._pixmapIcon = St.ImageContent.new_with_preferred_size(width, height);

        this._pixmapIcon.set_bytes(global.stage.context.get_backend().get_cogl_context(),
            data.get_data_as_bytes(), Cogl.PixelFormat.ARGB_8888, width, height, width * 4);

        return this._pixmapIcon;
    }

    _createNamedIcon(name, scale) {
        if (name.startsWith('/'))
            return new UncachedFileIcon(name);

        name = name.replace(/\.(png|svg)$/, '');

        const themePath = this._getString('IconThemePath');
        if (themePath) {
            this._iconTheme ??= new St.IconTheme();
            if (this._iconThemePath !== themePath) {
                this._iconTheme.set_search_path([themePath]);
                this._iconThemePath = themePath;
            }
            this._iconTheme.rescan_if_needed();

            const path = this._iconTheme.lookup_icon_for_scale(name, ICON_SIZE, scale, 0)?.get_filename();
            if (path)
                return new UncachedFileIcon(path);
        }

        return new Gio.ThemedIcon({ name });
    }

    _call(method, signature, args) {
        return Gio.DBus.session.call(this._name, this._path, ITEM_INTERFACE, method,
            new GLib.Variant(signature, args), null, Gio.DBusCallFlags.NONE, -1, this._cancellable);
    }

    _logCallError(method, e) {
        if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
            this._logger.warn(`${method} failed for ${this._name}${this._path}: ${e.message}`);
    }

    async _provideActivationToken(timestamp) {
        if (this._noActivationToken)
            return;

        const context = global.create_app_launch_context(timestamp, -1);
        const token = context.get_startup_notify_id(null, []);
        if (!token)
            return;

        try {
            await this._call('ProvideXdgActivationToken', '(s)', [token]);
        } catch (e) {
            context.launch_failed(token);
            this._noActivationToken = !!e.matches?.(Gio.DBusError, Gio.DBusError.UNKNOWN_METHOD);
        }
    }

    async _activate(x, y, timestamp) {
        try {
            await this._provideActivationToken(timestamp);
            await this._call('Activate', '(ii)', [x, y]);
        } catch (e) {
            if (e.matches?.(Gio.DBusError, Gio.DBusError.UNKNOWN_METHOD))
                this._supportsActivation = false;
            else
                this._logCallError('Activate', e);
        }
    }

    async _secondaryActivate(x, y, timestamp) {
        try {
            await this._provideActivationToken(timestamp);

            if (this._hasAyatanaSecondaryActivate !== false) {
                try {
                    await this._call('XAyatanaSecondaryActivate', '(u)', [timestamp]);
                    this._hasAyatanaSecondaryActivate = true;
                    return;
                } catch (e) {
                    if (!e.matches?.(Gio.DBusError, Gio.DBusError.UNKNOWN_METHOD))
                        throw e;
                    this._hasAyatanaSecondaryActivate = false;
                }
            }

            await this._call('SecondaryActivate', '(ii)', [x, y]);
        } catch (e) {
            this._logCallError('SecondaryActivate', e);
        }
    }

    _scroll(delta, orientation) {
        if (delta)
            this._call('Scroll', '(is)', [delta, orientation]).catch(e => this._logCallError('Scroll', e));
    }

    _isDoubleClick(event) {
        const [x, y] = event.get_coords();
        const time = event.get_time();
        const { doubleClickTime, doubleClickDistance } = this.get_context().get_settings();
        const last = this._lastClick;

        const isDoubleClick = !!last && !last.isDoubleClick
            && time - last.time <= doubleClickTime
            && Math.abs(x - last.x) <= doubleClickDistance
            && Math.abs(y - last.y) <= doubleClickDistance;
        this._lastClick = { x, y, time, isDoubleClick };

        return isDoubleClick;
    }

    vfunc_button_press_event(event) {
        if (this._clickId) {
            GLib.Source.remove(this._clickId);
            this._clickId = 0;
        }

        const button = event.get_button();
        const [x, y] = event.get_coords().map(Math.round);
        const time = event.get_time();

        if (button === Clutter.BUTTON_MIDDLE) {
            Main.panel.menuManager.activeMenu?.close();
            this._secondaryActivate(x, y, time);
            return Clutter.EVENT_STOP;
        }

        if (button === Clutter.BUTTON_SECONDARY) {
            this.menu.toggle();
            return Clutter.EVENT_PROPAGATE;
        }

        if (button !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        if (this._supportsActivation && this._isDoubleClick(event)) {
            this._activate(x, y, time);
            return Clutter.EVENT_STOP;
        }

        if (!this.menu.numMenuItems)
            return Clutter.EVENT_PROPAGATE;

        if (!this._supportsActivation) {
            this.menu.toggle();
            return Clutter.EVENT_PROPAGATE;
        }

        const { doubleClickTime } = this.get_context().get_settings();
        this._clickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, doubleClickTime, () => {
            this._clickId = 0;
            this.menu.toggle();
            return GLib.SOURCE_REMOVE;
        });

        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_event(event) {
        if (event.type() === Clutter.EventType.TOUCH_BEGIN && this.menu.numMenuItems)
            this.menu.toggle();

        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_scroll_event(event) {
        if (event.get_scroll_direction() !== Clutter.ScrollDirection.SMOOTH)
            return Clutter.EVENT_PROPAGATE;

        const [dx, dy] = event.get_scroll_delta();
        this._scroll(this._accumulateScroll('_scrollX', dx), 'horizontal');
        this._scroll(this._accumulateScroll('_scrollY', dy), 'vertical');

        const finishFlags = event.get_scroll_finish_flags();
        if (finishFlags & Clutter.ScrollFinishFlags.HORIZONTAL)
            this._scrollX = 0;
        if (finishFlags & Clutter.ScrollFinishFlags.VERTICAL)
            this._scrollY = 0;

        return Clutter.EVENT_STOP;
    }

    _accumulateScroll(accumulator, delta) {
        if (Math.sign(this[accumulator]) === -Math.sign(delta))
            this[accumulator] = 0;

        this[accumulator] += delta;
        const steps = Math.trunc(this[accumulator]);
        this[accumulator] -= steps;

        return steps;
    }
});

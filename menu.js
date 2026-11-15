import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';


const MENU_INTERFACE = 'com.canonical.dbusmenu';
const REBUILD_DELAY_MS = 50;


function getProperty(properties, name, type) {
    const value = properties[name];
    return value?.get_type_string() === type ? value.unpack() : null;
}

function getItemType(properties) {
    if (getProperty(properties, 'children-display', 's') === 'submenu')
        return 'submenu';

    return getProperty(properties, 'type', 's') === 'separator' ? 'separator' : 'standard';
}

function updateItem(item) {
    const properties = item._dbusProperties;

    item.label.text = (getProperty(properties, 'label', 's') ?? '').replace(/_(_?)/g, '$1');
    item.visible = getProperty(properties, 'visible', 'b') ?? true;

    if (item._dbusType === 'separator')
        return;

    item.setSensitive(getProperty(properties, 'enabled', 'b') ?? true);

    const toggleType = getProperty(properties, 'toggle-type', 's');
    const toggled = getProperty(properties, 'toggle-state', 'i') === 1;
    if (toggleType === 'checkmark')
        item.setOrnament(toggled ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
    else if (toggleType === 'radio')
        item.setOrnament(toggled ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
    else
        item.setOrnament(PopupMenu.Ornament.NONE);

    if (!item._icon)
        return;

    const iconName = getProperty(properties, 'icon-name', 's');
    const iconData = properties['icon-data'];
    if (iconName)
        item._icon.gicon = new Gio.ThemedIcon({ name: iconName });
    else if (iconData?.get_type_string() === 'ay' && iconData.n_children())
        item._icon.gicon = new Gio.BytesIcon({ bytes: iconData.get_data_as_bytes() });
    else
        item._icon.gicon = null;
    item._icon.visible = !!item._icon.gicon;
}


export class DBusMenu {
    constructor(name, owner, menu, logger, provideActivationToken) {
        this._name = name;
        this._owner = owner;
        this._menu = menu;
        this._logger = logger;
        this._provideActivationToken = provideActivationToken;
        this._path = null;
        this._items = new Map();
        this._cancellable = new Gio.Cancellable();
        this._signalId = 0;
        this._rebuildId = 0;
        this._layoutSerial = 0;

        this._menu._setOpenedSubMenu = () => {};
        this._openStateId = this._menu.connect('open-state-changed',
            (_menu, open) => this._onOpenStateChanged(0, this._menu, open));
    }

    setPath(path) {
        this._reset();

        if (!path)
            return;

        this._path = path;
        this._signalId = Gio.DBus.session.signal_subscribe(this._owner, MENU_INTERFACE, null, path, null,
            Gio.DBusSignalFlags.NONE, (_bus, _sender, _path, _iface, signal, params) => {
                if (signal === 'LayoutUpdated')
                    this._queueRebuild();
                else if (signal === 'ItemsPropertiesUpdated')
                    this._updateProperties(params);
            });

        this._aboutToShow(0);
        this._rebuild();
    }

    destroy() {
        this._reset();
        this._menu.disconnect(this._openStateId);
        delete this._menu._setOpenedSubMenu;
    }

    _reset() {
        this._path = null;
        this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();

        if (this._signalId)
            Gio.DBus.session.signal_unsubscribe(this._signalId);
        if (this._rebuildId)
            GLib.Source.remove(this._rebuildId);
        this._signalId = this._rebuildId = 0;

        this._clear();
    }

    _clear() {
        this._menu.removeAll();
        this._menu._openedSubMenu = null;
        this._items.clear();
    }

    _call(method, signature, args, replyType = null) {
        return Gio.DBus.session.call(this._name, this._path, MENU_INTERFACE, method,
            new GLib.Variant(signature, args), replyType && new GLib.VariantType(replyType),
            Gio.DBusCallFlags.NONE, -1, this._cancellable);
    }

    _queueRebuild() {
        if (this._rebuildId)
            return;

        this._rebuildId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REBUILD_DELAY_MS, () => {
            this._rebuildId = 0;
            this._rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _rebuild() {
        const serial = ++this._layoutSerial;

        try {
            const reply = await this._call('GetLayout', '(iias)', [0, -1, []], '(u(ia{sv}av))');
            if (serial !== this._layoutSerial)
                return;

            const [, [, , children]] = reply.deepUnpack();
            this._clear();
            children.forEach(child => this._addItem(this._menu, child.deepUnpack()));
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                this._logger.warn(`Could not get the menu of ${this._name}: ${e.message}`);
        }
    }

    _addItem(menu, [id, properties, children]) {
        const type = getItemType(properties);
        const item = type === 'submenu' ? new PopupMenu.PopupSubMenuMenuItem('')
            : type === 'separator' ? new PopupMenu.PopupSeparatorMenuItem('')
                : new PopupMenu.PopupMenuItem('');

        item._dbusType = type;
        item._dbusProperties = properties;

        if (type === 'standard') {
            item._icon = new St.Icon({ style_class: 'popup-menu-icon', x_align: Clutter.ActorAlign.END });
            item.add_child(item._icon);
            item.label.x_expand = true;
            item.connect('activate', (_item, event) => this._activate(id, event?.get_time() ?? 0));
        }

        updateItem(item);
        menu.addMenuItem(item);
        this._items.set(id, item);

        if (type === 'submenu') {
            children.forEach(child => this._addItem(item.menu, child.deepUnpack()));
            item.menu.connect('open-state-changed',
                (subMenu, open) => this._onOpenStateChanged(id, subMenu, open));
        }
    }

    _updateProperties(params) {
        const [updated, removed] = params.deepUnpack();
        const items = new Set();

        for (const [id, properties] of updated) {
            const item = this._items.get(id);
            if (item) {
                Object.assign(item._dbusProperties, properties);
                items.add(item);
            }
        }

        for (const [id, names] of removed) {
            const item = this._items.get(id);
            if (item) {
                names.forEach(name => delete item._dbusProperties[name]);
                items.add(item);
            }
        }

        for (const item of items) {
            if (item._dbusType !== getItemType(item._dbusProperties)) {
                this._queueRebuild();
                return;
            }
            updateItem(item);
        }
    }

    _onOpenStateChanged(id, menu, open) {
        if (menu !== this._menu) {
            menu._openedSubMenu?.close({ animate: false });
            menu._openedSubMenu = null;

            if (open && menu._parent._openedSubMenu !== menu) {
                menu._parent._openedSubMenu?.close();
                menu._parent._openedSubMenu = menu;
            }
        }

        if (!this._path)
            return;

        this._sendEvent(id, open ? 'opened' : 'closed');
        if (open)
            this._aboutToShow(id);
    }

    async _aboutToShow(id) {
        if (this._noAboutToShow)
            return;

        try {
            const reply = await this._call('AboutToShow', '(i)', [id]);
            const replyType = reply.get_type_string();

            if (replyType === '()' || (replyType === '(b)' && reply.get_child_value(0).get_boolean()))
                this._queueRebuild();
        } catch (e) {
            this._noAboutToShow = !!e.matches?.(Gio.DBusError, Gio.DBusError.UNKNOWN_METHOD);
        }
    }

    _sendEvent(id, event, timestamp = 0) {
        if (this._path) {
            this._call('Event', '(isvu)', [id, event, new GLib.Variant('i', 0), timestamp])
                .catch(() => {});
        }
    }

    async _activate(id, timestamp) {
        await this._provideActivationToken(timestamp);
        this._sendEvent(id, 'clicked', timestamp);
    }
}

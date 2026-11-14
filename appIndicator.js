// This file is part of the AppIndicator/KStatusNotifierItem GNOME Shell extension
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program; if not, write to the Free Software
// Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import * as DBusUtils from './dbusUtils.js';
import * as Interfaces from './interfaces.js';
import * as PromiseUtils from './promiseUtils.js';
import * as Util from './util.js';
import {DBusProxy} from './dbusProxy.js';
import {IconCache} from './iconCache.js';

Gio._promisify(GdkPixbuf.Pixbuf, 'get_file_info_async');
Gio._promisify(GdkPixbuf.Pixbuf, 'new_from_stream_at_scale_async',
    'new_from_stream_finish');

const MAX_UPDATE_FREQUENCY = 30; // ms
const ICON_SIZE = 18; // px
// KDE hardcodes the overlay icon size to 10px (normal icon size 16px), we
// approximate that ratio. Our algorithms pick a smaller icon rather than
// stretching it.
const OVERLAY_ICON_SIZE = Math.floor(ICON_SIZE / 1.6);
const FALLBACK_ICON_NAME = 'image-loading-symbolic';

export const SNIStatus = Object.freeze({
    PASSIVE: 'Passive',
    ACTIVE: 'Active',
    NEEDS_ATTENTION: 'NeedsAttention',
});

const SNIconType = Object.freeze({
    NORMAL: 0,
    ATTENTION: 1,
    OVERLAY: 2,
});

// Properties prefixes, indexed by SNIconType
const ICON_PROPERTIES = ['Icon', 'AttentionIcon', 'OverlayIcon'];

// Not declared in the interface, as not all the implementations provide them
const OPTIONAL_PROPERTIES = ['XAyatanaLabel', 'IconAccessibleDesc', 'AttentionAccessibleDesc'];

const NEEDED_PROPERTIES = ['Id', 'Menu', 'Status'];

let sniInterfaceInfo = null;

const AppIndicatorProxy = GObject.registerClass(
class AppIndicatorProxy extends DBusProxy {
    _init(busName, objectPath) {
        sniInterfaceInfo ??= Gio.DBusInterfaceInfo.new_for_xml(Interfaces.StatusNotifierItem);

        super._init(busName, objectPath, sniInterfaceInfo,
            Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES);

        this.set_cached_property('Status', new GLib.Variant('s', SNIStatus.PASSIVE));

        this._propertiesList = [];
        this._accumulatedProperties = new Set();
        this._changedProperties = {};
        this._signalsAccumulator = null;
        this._propertiesEmitTimeout = null;
    }

    async initAsync() {
        await super.initAsync();
        this._setupProxyPropertyList();
    }

    destroy() {
        // Free the cached properties memory (pixmaps can be big)
        (this.get_cached_property_names() ?? []).forEach(name =>
            this.set_cached_property(name, null));

        super.destroy();
    }

    // The optional properties are not type checked by the proxy
    getOptionalString(propertyName) {
        const value = this.get_cached_property(propertyName);
        return value?.get_type_string() === 's' ? value.unpack() : null;
    }

    _onNameOwnerChanged() {
        NEEDED_PROPERTIES.forEach(name => this.set_cached_property(name, null));

        if (this.gNameOwner) {
            this._setupProxyPropertyList();
        } else {
            this._accumulatedProperties.clear();
            this._changedProperties = {};
        }
    }

    // The properties provided by the item, refreshed when it notifies changes
    _setupProxyPropertyList() {
        const interfaceProperties = this.gInterfaceInfo.properties.map(p => p.name);
        this._propertiesList = (this.get_cached_property_names() ?? []).filter(name =>
            interfaceProperties.includes(name));

        if (!this._propertiesList.length)
            return;

        OPTIONAL_PROPERTIES.forEach(name => {
            this._propertiesList.push(name);

            const value = this.get_cached_property(name);
            if (value) {
                this._queuePropertyUpdate(name, value, true).catch(e =>
                    Util.logErrorUnlessCancelled(e));
            }
        });
    }

    _onSignal(_sender, signal, params) {
        this._onSignalAsync(signal, params).catch(e =>
            Util.logErrorUnlessCancelled(e, `Error while processing signal '${signal}'`));
    }

    async _onSignalAsync(signal, params) {
        // The author of the spec didn't like the PropertiesChanged signal,
        // so he invented his own
        let property;
        if (signal.startsWith('New'))
            property = signal.slice(3);
        else if (signal.startsWith('XAyatanaNew'))
            property = `XAyatana${signal.slice(11)}`;
        else
            return;

        if (params.n_children()) {
            // The signal includes the new value, no need to fetch it
            await this._queuePropertyUpdate(property, params.get_child_value(0));

            if (!this._accumulatedProperties.size)
                return;
        } else {
            this._accumulatedProperties.add(property);
        }

        if (this._signalsAccumulator)
            return;

        // The accumulator is released before refreshing the properties, so
        // that the signals received meanwhile are not missed
        try {
            this._signalsAccumulator = new PromiseUtils.TimeoutPromise(
                MAX_UPDATE_FREQUENCY, GLib.PRIORITY_DEFAULT_IDLE, this._cancellable);
            await this._signalsAccumulator;
        } finally {
            this._signalsAccumulator = null;
        }

        const properties = [...this._accumulatedProperties];
        this._accumulatedProperties.clear();
        await Promise.all(properties.map(p => this._refreshOwnProperties(p)));
    }

    async _refreshOwnProperties(prop) {
        const props = [prop, `${prop}Name`, `${prop}Pixmap`, `${prop}AccessibleDesc`];

        // NewIconThemePath is not a standard signal, so on icon update we need
        // to also refresh the theme path.
        if (prop.endsWith('Icon'))
            props.unshift('IconThemePath');

        await Promise.all(props.filter(p => this._propertiesList.includes(p)).map(async p => {
            try {
                // Pixmaps comparison is expensive, and they are rarely equal
                await this.refreshProperty(p, p.endsWith('Pixmap'));
            } catch (e) {
                if (!OPTIONAL_PROPERTIES.includes(p) || !(e instanceof Gio.DBusError))
                    logError(e);
            }
        }));
    }

    async refreshAllProperties() {
        try {
            const reply = await this.getProperties(this._cancellable);
            const [properties] = reply.deepUnpack();

            await Promise.all(Object.entries(properties).map(([name, value]) =>
                this._queuePropertyUpdate(name, value, true)));
        } catch (e) {
            if (!Util.isCancelled(e)) {
                (this.get_cached_property_names() ?? []).forEach(name =>
                    this.set_cached_property(name, null));
            }
            throw e;
        }
    }

    async refreshProperty(propertyName, skipEqualityCheck = false) {
        try {
            const reply = await this.getProperty(propertyName, this._cancellable);
            const [value] = reply.deepUnpack();

            await this._queuePropertyUpdate(propertyName, value, skipEqualityCheck);
        } catch (e) {
            if (Util.isCancelled(e))
                return;

            // the property may not even exist
            this.set_cached_property(propertyName, null);
            delete this._changedProperties[propertyName];
            throw e;
        }
    }

    // Synthesizes a batched property changed event
    async _queuePropertyUpdate(propertyName, value, skipEqualityCheck = false) {
        if (!skipEqualityCheck) {
            const cachedValue = this.get_cached_property(propertyName);
            if (cachedValue && value.equal(cachedValue))
                return;
        }

        this.set_cached_property(propertyName, value);
        this._changedProperties[propertyName] = value;

        if (this._propertiesEmitTimeout?.pending())
            return;

        this._propertiesEmitTimeout = new PromiseUtils.TimeoutPromise(
            MAX_UPDATE_FREQUENCY * 2, GLib.PRIORITY_DEFAULT_IDLE, this._cancellable);
        await this._propertiesEmitTimeout;

        const changedProperties = this._changedProperties;
        this._changedProperties = {};

        if (Object.keys(changedProperties).length) {
            this.emit('g-properties-changed',
                new GLib.Variant('a{sv}', changedProperties), []);
        }
    }
});

/**
 * The AppIndicator class serves as a generic container for indicator
 * information and functions common for every displaying implementation
 */
export class AppIndicator extends Signals.EventEmitter {
    constructor(service, busName, objectPath) {
        super();

        this.isReady = false;
        this.busName = busName;
        this._service = service;
        this._uniqueId = Util.indicatorId(service, busName, objectPath);
        this._cancellable = new Gio.Cancellable();
        this._proxy = new AppIndicatorProxy(busName, objectPath);
        this._appInfo = null;
        this._pid = null;

        this._proxy.connectObject(
            'g-properties-changed', (_proxy, changed) => this._onPropertiesChanged(changed),
            'notify::g-name-owner', () => this._nameOwnerChanged().catch(logError),
            this);

        Shell.AppSystem.get_default().connectObject(
            'installed-changed', () => this._updateAppInfo(),
            'app-state-changed', () => this._updateAppInfo(),
            this);

        this._setupProxy().catch(logError);
    }

    async _setupProxy() {
        try {
            await this._proxy.initAsync();
            this._checkIfReady();
            await this._proxy.refreshAllProperties();
        } catch (e) {
            if (!Util.isCancelled(e)) {
                logError(e, `While initializing proxy for ${this._uniqueId}`);
                this.destroy();
            }
            return;
        }

        this._updateAppInfo();

        // We try to lookup the activate method to see if the app supports it
        try {
            const reply = await this._proxy.gConnection.call(
                this._proxy.gNameOwner, this._proxy.gObjectPath,
                'org.freedesktop.DBus.Introspectable', 'Introspect', null,
                new GLib.VariantType('(s)'), Gio.DBusCallFlags.NONE, -1,
                this._cancellable);
            const [xml] = reply.deepUnpack();
            const interfaceInfo = Gio.DBusNodeInfo.new_for_xml(xml).lookup_interface(
                this._proxy.gInterfaceName);

            this.supportsActivation = !!interfaceInfo.lookup_method('Activate');
            this._hasAyatanaSecondaryActivate =
                !!interfaceInfo.lookup_method('XAyatanaSecondaryActivate');
        } catch (e) {
            if (!Util.isCancelled(e))
                console.debug(`${this._uniqueId}, check for Activation support: ${e.message}`);
        }
    }

    // Only used to get a better accessible name
    async _updateAppInfo() {
        if (this._appInfo || !this.hasNameOwner)
            return;

        try {
            this._pid ??= await DBusUtils.getProcessId(this.busName, this._cancellable);
            this._appInfo = Shell.WindowTracker.get_default().get_app_from_pid(
                this._pid)?.appInfo ?? null;

            if (this._appInfo)
                this.emit('accessible-name');
        } catch (e) {
            if (!Util.isCancelled(e))
                console.debug(`${this._uniqueId}, failed getting the app info: ${e.message}`);
        }
    }

    _checkIfReady() {
        const wasReady = this.isReady;
        this.isReady = !!(this.hasNameOwner && this.id && this.menuPath);

        if (this.isReady && !wasReady) {
            this._delayCheck?.cancel();
            this.emit('ready');
            return true;
        }

        return false;
    }

    async _checkNeededProperties() {
        const MAX_RETRIES = 3;

        for (let retry = 0; retry < MAX_RETRIES && !(this.id && this.menuPath); retry++) {
            this._delayCheck = new PromiseUtils.TimeoutSecondsPromise(1,
                GLib.PRIORITY_DEFAULT_IDLE, this._cancellable);

            try {
                // eslint-disable-next-line no-await-in-loop
                await this._delayCheck;
                // eslint-disable-next-line no-await-in-loop
                await Promise.all(NEEDED_PROPERTIES.map(p => this._proxy.refreshProperty(p)));
            } catch (e) {
                if (Util.isCancelled(e) || retry === MAX_RETRIES - 1)
                    throw e;
            } finally {
                this._delayCheck = null;
            }
        }
    }

    async _nameOwnerChanged() {
        if (!this.hasNameOwner) {
            this._checkIfReady();
        } else {
            try {
                await this._checkNeededProperties();
            } catch (e) {
                if (!Util.isCancelled(e)) {
                    console.warn(`${this._uniqueId}, impossible to get basic properties: ${e}`);
                    this.checkAlive().catch(logError);
                }
            }
        }

        if (this._cancellable.is_cancelled())
            return;

        this._appInfo = null;
        this._pid = null;
        this._updateAppInfo();

        this.emit('name-owner-changed');
    }

    // public property getters
    get title() {
        return this._proxy.Title;
    }

    get id() {
        return this._proxy.Id;
    }

    get uniqueId() {
        return this._uniqueId;
    }

    get service() {
        return this._service;
    }

    get status() {
        return this._proxy.Status;
    }

    get label() {
        return this._proxy.getOptionalString('XAyatanaLabel') || null;
    }

    get accessibleName() {
        const accessibleDesc = this._proxy.getOptionalString(
            this.status === SNIStatus.NEEDS_ATTENTION
                ? 'AttentionAccessibleDesc' : 'IconAccessibleDesc');

        return accessibleDesc || this.label ||
            this._appInfo?.get_display_name() || this.title || '';
    }

    get menuPath() {
        const {Menu: menuPath} = this._proxy;
        return menuPath === '/NO_DBUSMENU' ? null : menuPath;
    }

    get hasNameOwner() {
        return !!this._proxy.gNameOwner;
    }

    get cancellable() {
        return this._cancellable;
    }

    getIcon(iconType) {
        const prefix = ICON_PROPERTIES[iconType];

        return {
            theme: this._proxy.IconThemePath,
            name: this._proxy[`${prefix}Name`],
            pixmap: this._proxy.get_cached_property(`${prefix}Pixmap`),
        };
    }

    _hasIcon(iconType) {
        const {name, pixmap} = this.getIcon(iconType);
        return !!(name || pixmap?.n_children());
    }

    get hasAttentionIcon() {
        return this._hasIcon(SNIconType.ATTENTION);
    }

    get hasOverlayIcon() {
        return this._hasIcon(SNIconType.OVERLAY);
    }

    async checkAlive() {
        // Some applications (hey electron!) just remove the indicator object
        // from bus after hiding it, without closing its bus name, so we are
        // not able to understand when they're gone.
        // Thus we just kill it when an expected well-known method is failing.
        this._checkIfReady();
        if (this.status !== SNIStatus.PASSIVE && this.isReady) {
            this._checkAliveTimeout?.cancel();
            this._checkAliveTimeout = null;
            return;
        }

        if (this._checkAliveTimeout)
            return;

        const checkAliveTimeout = new PromiseUtils.TimeoutSecondsPromise(10,
            GLib.PRIORITY_DEFAULT_IDLE, this._cancellable);
        this._checkAliveTimeout = checkAliveTimeout;

        try {
            console.debug(`${this._uniqueId}: may not respond, checking...`);
            await checkAliveTimeout;

            // We should call the Ping method instead but in some containers
            // such as snaps that's not accessible, so let's just use our own
            await this._proxy.getProperty('Status', this._cancellable);
        } catch (e) {
            const {DBusError} = Gio;
            const isGone = [
                DBusError.NAME_HAS_NO_OWNER, DBusError.SERVICE_UNKNOWN,
                DBusError.UNKNOWN_OBJECT, DBusError.UNKNOWN_INTERFACE,
                DBusError.UNKNOWN_METHOD, DBusError.UNKNOWN_PROPERTY,
            ].some(code => e.matches?.(DBusError, code));

            if (isGone) {
                console.warn(`${this._uniqueId}: not on bus anymore, removing it`);
                this.destroy();
            } else {
                Util.logErrorUnlessCancelled(e);
            }
        } finally {
            if (this._checkAliveTimeout === checkAliveTimeout)
                this._checkAliveTimeout = null;
        }
    }

    // Some property changes require updates on our part,
    // a few need to be passed down to the displaying code
    _onPropertiesChanged(changed) {
        const signals = new Set();
        let readyChanged;
        const checkIfReadyChanged = () => (readyChanged ??= this._checkIfReady());

        Object.keys(changed.unpack()).forEach(property => {
            switch (property) {
            case 'Id':
                checkIfReadyChanged();
                break;
            case 'Menu':
                if (!checkIfReadyChanged() && this.isReady)
                    signals.add('menu');
                break;
            case 'Status':
                // status updates may cause the indicator to be hidden
                ['icon', 'overlay-icon', 'status', 'accessible-name'].forEach(s =>
                    signals.add(s));
                break;
            case 'IconThemePath':
                // this may make all of our icons invalid
                signals.add('icon');
                signals.add('overlay-icon');
                break;
            case 'XAyatanaLabel':
                signals.add('label');
                signals.add('accessible-name');
                break;
            case 'Title':
            case 'IconAccessibleDesc':
            case 'AttentionAccessibleDesc':
                signals.add('accessible-name');
                break;
            default:
                if (property.startsWith('OverlayIcon'))
                    signals.add('overlay-icon');
                else if (property.startsWith('Icon') || property.startsWith('AttentionIcon'))
                    signals.add('icon');
            }
        });

        signals.forEach(signal => this.emit(signal));
    }

    reset() {
        this.emit('reset');
    }

    destroy() {
        if (this._destroyed)
            return;

        this._destroyed = true;
        this.emit('destroy');
        this.disconnectAll();

        this._cancellable.cancel();
        this._proxy.disconnectObject(this);
        Shell.AppSystem.get_default().disconnectObject(this);
        this._proxy.destroy();
    }

    _getActivationToken(timestamp) {
        const launchContext = global.create_app_launch_context(timestamp, -1);
        // A null app info prevents the busy cursor
        return [launchContext, launchContext.get_startup_notify_id(null, [])];
    }

    async provideActivationToken(timestamp) {
        if (this._hasProvideXdgActivationToken === false)
            return;

        const [launchContext, activationToken] = this._getActivationToken(timestamp);
        if (!activationToken)
            return;

        try {
            await this._proxy.ProvideXdgActivationTokenAsync(activationToken,
                this._cancellable);
            this._hasProvideXdgActivationToken = true;
        } catch (e) {
            launchContext.launch_failed(activationToken);

            if (e.matches?.(Gio.DBusError, Gio.DBusError.UNKNOWN_METHOD))
                this._hasProvideXdgActivationToken = false;
            else if (!Util.isCancelled(e))
                console.warn(`${this.id}, failed to provide activation token: ${e.message}`);
        }
    }

    async open(x, y, timestamp) {
        // we can't use WindowID because we're not able to get the x11 window id
        // from a MetaWindow nor can we call any X11 functions. Luckily, the
        // Activate method usually works fine. parameters are "an hint to the
        // item where to show eventual windows" [sic] ... and don't seem to have
        // any effect.
        try {
            await this.provideActivationToken(timestamp);
            await this._proxy.ActivateAsync(x, y, this._cancellable);
            this.supportsActivation = true;
        } catch (e) {
            if (e.matches?.(Gio.DBusError, Gio.DBusError.UNKNOWN_METHOD)) {
                this.supportsActivation = false;
                console.warn(`${this.id}, does not support activation: ${e.message}`);
            } else if (!Util.isCancelled(e)) {
                console.error(`${this.id}, failed to activate: ${e.message}`);
            }
        }
    }

    async secondaryActivate(timestamp, x, y) {
        try {
            await this.provideActivationToken(timestamp);

            if (this._hasAyatanaSecondaryActivate !== false) {
                try {
                    await this._proxy.XAyatanaSecondaryActivateAsync(timestamp,
                        this._cancellable);
                    this._hasAyatanaSecondaryActivate = true;
                } catch (e) {
                    if (e.matches?.(Gio.DBusError, Gio.DBusError.UNKNOWN_METHOD))
                        this._hasAyatanaSecondaryActivate = false;
                    else
                        throw e;
                }
            }

            if (!this._hasAyatanaSecondaryActivate)
                await this._proxy.SecondaryActivateAsync(x, y, this._cancellable);
        } catch (e) {
            if (!Util.isCancelled(e))
                console.error(`${this.id}, failed to secondary activate: ${e.message}`);
        }
    }

    async scroll(dx, dy) {
        try {
            await Promise.all([
                dx && this._proxy.ScrollAsync(dx, 'horizontal', this._cancellable),
                dy && this._proxy.ScrollAsync(dy, 'vertical', this._cancellable),
            ]);
        } catch (e) {
            if (!Util.isCancelled(e))
                console.error(`${this.id}, failed to scroll: ${e.message}`);
        }
    }
}

const StTextureCacheSkippingFileIcon = GObject.registerClass({
    Implements: [Gio.Icon],
}, class StTextureCacheSkippingFileIconImpl extends Gio.EmblemedIcon {
    _init(params) {
        // FIXME: We can't just inherit from Gio.FileIcon for some reason
        super._init({gicon: new Gio.FileIcon(params)});
    }

    vfunc_to_tokens() {
        // Disables the to_tokens() vfunc so that the icon to_string()
        // method won't work and thus can't be kept forever around by
        // StTextureCache, see the awesome debugging session in this thread:
        //   https://twitter.com/mild_sunrise/status/1458739604098621443
        // upstream bug is at:
        //   https://gitlab.gnome.org/GNOME/gnome-shell/-/issues/4944
        return [false, [], 0];
    }
});

let userWritablePaths = null;

function isFileInWritableArea(file) {
    // No need to use IO here, we can just do some assumptions
    userWritablePaths ??= [
        GLib.get_user_cache_dir(),
        GLib.get_user_data_dir(),
        GLib.get_user_config_dir(),
        GLib.get_user_runtime_dir(),
        GLib.get_home_dir(),
        GLib.get_tmp_dir(),
    ];

    const path = file.get_path();
    return userWritablePaths.some(writablePath => path.startsWith(writablePath));
}

// We prefer the smallest pixmap that is equal or bigger than the requested
// size, or the biggest one.
function getBestPixmap(pixmapsVariant, preferredSize) {
    const pixmaps = [];

    for (let i = 0; i < pixmapsVariant.n_children(); i++) {
        const pixmap = pixmapsVariant.get_child_value(i);
        const width = pixmap.get_child_value(0).get_int32();
        const height = pixmap.get_child_value(1).get_int32();
        const data = pixmap.get_child_value(2);

        // Skip the invalid pixmaps, the data must contain the ARGB32 pixels
        if (width > 0 && height > 0 && data.n_children() >= width * height * 4)
            pixmaps.push({width, height, data});
    }

    if (!pixmaps.length)
        throw new Error('No valid icon pixmap');

    pixmaps.sort((a, b) => a.width * a.height - b.width * b.height);

    return pixmaps.find(({width, height}) =>
        width >= preferredSize && height >= preferredSize) ?? pixmaps.at(-1);
}

// An icon is either {gicon}, or {content, width, height} for the images that
// are not used as GIcons (pixmaps without overlay, wide images). The icons
// made from pixmaps are flagged with fromPixmap.
export const IconActor = GObject.registerClass(
class AppIndicatorsIconActor extends St.Icon {
    _init(indicator) {
        super._init({
            reactive: true,
            style_class: 'system-status-icon appindicator-icon status-notifier-icon',
            icon_size: ICON_SIZE,
            fallback_icon_name: FALLBACK_ICON_NAME,
        });

        this._indicator = indicator;
        this._iconCache = new IconCache();
        this._baseIcon = null;
        this._overlayGicon = null;
        this._loadingCancellables = new Map(); // isOverlay -> Gio.Cancellable
        this._needsInvalidation = true;

        indicator.connectObject(
            'ready', () => this._updateStyleClass(),
            'reset', () => this._invalidateWhenMapped(),
            'icon', () => this._updateWhenMapped(() => this._updateIcon()),
            'overlay-icon', () => this._updateWhenMapped(() => this._onOverlayIconChanged()),
            this);

        St.TextureCache.get_default().connectObject('icon-theme-changed',
            () => this._invalidateWhenMapped(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject('notify::scale-factor',
            () => this._invalidateWhenMapped(), this);

        this.connect('resource-scale-changed', () => this._invalidateWhenMapped());
        this.connect('notify::mapped', () => {
            if (this.mapped && this._needsInvalidation)
                this._invalidateIcon();
        });
        this.connect('destroy', () => {
            this._cancelLoadings();
            this._iconCache.destroy();
            this._iconTheme = null;
            this._indicator = null;
        });

        if (indicator.isReady)
            this._updateStyleClass();
    }

    get debugId() {
        return this._indicator?.id ?? this.toString();
    }

    _updateStyleClass() {
        const id = this._indicator.id.toLowerCase().replace(/_|\s/g, '-');
        this.add_style_class_name(`appindicator-icon-${id}`);
    }

    _onOverlayIconChanged() {
        // A base pixmap is only turned into a GIcon when there's an overlay
        // to show as an emblem
        const baseIcon = this._baseIcon;
        if (baseIcon?.fromPixmap && !!baseIcon.gicon !== this._indicator.hasOverlayIcon)
            this._updateIcon();

        this._updateOverlayIcon();
    }

    // Icons are only updated when the actor is visible
    _updateWhenMapped(update) {
        if (this.mapped)
            update();
        else
            this._needsInvalidation = true;
    }

    _invalidateWhenMapped() {
        this._updateWhenMapped(() => this._invalidateIcon());
    }

    _invalidateIcon() {
        this._needsInvalidation = false;
        this._iconCache.clear();
        this._cancelLoadings();

        this._updateIcon();
        this._updateOverlayIcon();
    }

    _cancelLoadings() {
        this._loadingCancellables.forEach(cancellable => cancellable.cancel());
        this._loadingCancellables.clear();
    }

    _updateIcon() {
        const {status} = this._indicator;
        if (status === SNIStatus.PASSIVE)
            return;

        // the attention icon, if any, takes precedence over the normal one
        const iconType = status === SNIStatus.NEEDS_ATTENTION && this._indicator.hasAttentionIcon
            ? SNIconType.ATTENTION : SNIconType.NORMAL;

        this._updateIconByType(iconType, ICON_SIZE).catch(logError);
    }

    _updateOverlayIcon() {
        if (this._indicator.status === SNIStatus.PASSIVE)
            return;

        this._updateIconByType(SNIconType.OVERLAY, OVERLAY_ICON_SIZE).catch(logError);
    }

    async _updateIconByType(iconType, iconSize) {
        const isOverlay = iconType === SNIconType.OVERLAY;

        // A new update supersedes the one in progress, if any
        this._loadingCancellables.get(isOverlay)?.cancel();
        const cancellable = new Gio.Cancellable();
        this._loadingCancellables.set(isOverlay, cancellable);

        const {theme, name, pixmap} = this._indicator.getIcon(iconType);
        let icon = null;

        try {
            icon = await this._createIcon(name, pixmap, theme, iconType, iconSize,
                cancellable);
        } catch (e) {
            if (Util.isCancelled(e))
                return;

            logError(e, `${this.debugId}: unable to update the ${isOverlay ? 'overlay ' : ''}icon`);
        } finally {
            if (this._loadingCancellables.get(isOverlay) === cancellable)
                this._loadingCancellables.delete(isOverlay);
        }

        if (cancellable.is_cancelled())
            return;

        if (isOverlay)
            this._overlayGicon = icon?.gicon ?? null;
        else
            this._baseIcon = icon;

        this._applyIcon();
    }

    _applyIcon() {
        const {content, width, height, gicon: baseGicon} = this._baseIcon ?? {};

        if (content) {
            this.set({
                gicon: null,
                fallback_icon_name: null,
                content,
                content_gravity: Clutter.ContentGravity.RESIZE_ASPECT,
                width,
                height,
            });
            return;
        }

        if (this.content)
            this.set({content: null, width: -1, height: -1});

        let gicon = baseGicon ?? null;
        if (gicon && this._overlayGicon) {
            gicon = new Gio.EmblemedIcon({gicon});
            gicon.add_emblem(new Gio.Emblem({icon: this._overlayGicon}));
        }

        this.set({gicon, fallback_icon_name: FALLBACK_ICON_NAME});
    }

    async _createIcon(name, pixmap, theme, iconType, iconSize, cancellable) {
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const iconScaling = Math.ceil(this.get_resource_scale() * scaleFactor);

        if (name) {
            const icon = await this._cacheOrCreateIconByName(iconType, iconSize,
                iconScaling, name, theme, cancellable);
            if (icon)
                return icon;
        }

        if (pixmap?.n_children()) {
            return this._createIconFromPixmap(iconType, iconSize, iconScaling,
                scaleFactor, pixmap, cancellable);
        }

        return null;
    }

    // Will look the icon up in the cache, if it's found it will return it.
    // Otherwise, it will create it and cache it.
    async _cacheOrCreateIconByName(iconType, iconSize, iconScaling, name, themePath, cancellable) {
        // Attention icons replace the normal ones, so they share the cache
        const cacheType = iconType === SNIconType.OVERLAY ? iconType : SNIconType.NORMAL;
        const id = `${cacheType}:${name}@${iconSize * iconScaling}:${themePath ?? ''}`;

        const gicon = this._iconCache.get(id);
        if (gicon)
            return {gicon};

        const icon = await this._createIconByName(name, themePath, iconSize,
            iconScaling, iconType !== SNIconType.OVERLAY, cancellable);

        if (icon?.gicon && !icon.uncached)
            this._iconCache.add(id, icon.gicon);

        return icon;
    }

    async _createIconByName(name, themePath, iconSize, iconScaling, allowWideImage, cancellable) {
        let file;

        if (name[0] === '/') {
            // HACK: icon is a path name. This is not specified by the API,
            // but at least indicator-sensors uses it.
            file = Gio.File.new_for_path(name);
        } else {
            name = name.replace(/\.(png|svg)$/, '');

            // If a theme path is provided, we need to lookup the icon ourself
            // as St won't be able to do it unless we mess with default theme
            // that is something we prefer not to do, as it would imply lots of
            // St.TextureCache cleanups.
            if (!themePath || Util.getDefaultIconTheme().get_search_path().includes(themePath))
                return {gicon: new Gio.ThemedIcon({name})};

            const iconInfo = this._lookupIcon(name, themePath, iconSize, iconScaling);
            if (!iconInfo) {
                // Fallback to the default icon theme, without caching the
                // result as the icon may be added to the theme path later
                console.debug(`${this.debugId}, icon '${name}' not found in ${themePath}`);
                return {gicon: new Gio.ThemedIcon({name}), uncached: true};
            }

            file = Gio.File.new_for_path(iconInfo.get_filename());
        }

        if (!isFileInWritableArea(file))
            return {gicon: new Gio.FileIcon({file})};

        const [format, width, height] = await GdkPixbuf.Pixbuf.get_file_info_async(
            file.get_path(), cancellable);

        if (!format)
            throw new Error(`Invalid image format: ${file.get_path()}`);

        if (allowWideImage && width >= height * 1.5) {
            // Hello indicator-multiload!
            return this._loadWideImage(file, width, height, iconScaling, cancellable);
        }

        // We'll wrap the icon so that it won't be cached forever by the shell
        return {gicon: new StTextureCacheSkippingFileIcon({file})};
    }

    _lookupIcon(name, themePath, iconSize, iconScaling) {
        this._iconTheme ??= new St.IconTheme();

        if (this._iconThemePath !== themePath) {
            this._iconTheme.set_search_path([themePath]);
            this._iconThemePath = themePath;
        }

        let lookupFlags = St.IconLookupFlags.GENERIC_FALLBACK;

        const iconStyle = this.get_theme_node().get_icon_style();
        if (iconStyle === St.IconStyle.REGULAR)
            lookupFlags |= St.IconLookupFlags.FORCE_REGULAR;
        else if (iconStyle === St.IconStyle.SYMBOLIC)
            lookupFlags |= St.IconLookupFlags.FORCE_SYMBOLIC;

        lookupFlags |= this.get_text_direction() === Clutter.TextDirection.RTL
            ? St.IconLookupFlags.DIR_RTL : St.IconLookupFlags.DIR_LTR;

        return this._iconTheme.lookup_icon_for_scale(name, iconSize, iconScaling,
            lookupFlags);
    }

    async _loadWideImage(file, width, height, iconScaling, cancellable) {
        const textureCache = St.TextureCache.get_default();
        const imageActor = textureCache.load_file_async(file, -1, height, 1, iconScaling);

        try {
            if (!imageActor.content) {
                // Wait for the image to be loaded, at most one second
                const promises = [
                    new PromiseUtils.SignalConnectionPromise(imageActor,
                        'notify::content', cancellable),
                    new PromiseUtils.TimeoutSecondsPromise(1, GLib.PRIORITY_DEFAULT,
                        cancellable),
                ];

                try {
                    await Promise.race(promises);
                } finally {
                    promises.forEach(p => p.cancel());
                }
            }

            const {content} = imageActor;
            if (!content)
                return null;

            const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
            return {content, width: width * scaleFactor, height: height * scaleFactor};
        } finally {
            imageActor.content = null;
            imageActor.destroy();
        }
    }

    async _createIconFromPixmap(iconType, iconSize, iconScaling, scaleFactor, pixmapsVariant,
        cancellable) {
        const {width, height, data} = getBestPixmap(pixmapsVariant, iconSize * iconScaling);

        const imageContent = St.ImageContent.new_with_preferred_size(width, height);
        const coglContext = global.stage.context.get_backend().get_cogl_context();
        imageContent.set_bytes(coglContext, data.get_data_as_bytes(),
            Cogl.PixelFormat.ARGB_8888, width, height, width * 4);

        if (iconType !== SNIconType.OVERLAY && !this._indicator.hasOverlayIcon) {
            const size = iconSize * scaleFactor;
            return {content: imageContent, width: size, height: size, fromPixmap: true};
        }

        // A GIcon is needed to show the overlay as an emblem
        // FIXME: async API results in a gray icon for some reason
        const [inputStream] = imageContent.load(iconSize, cancellable);
        const gicon = await GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
            inputStream, -1, iconSize * iconScaling, true, cancellable);
        return {gicon, fromPixmap: true};
    }
});

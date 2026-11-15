import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Indicator } from './indicator.js';


Gio._promisify(Gio.DBusConnection.prototype, 'call');

const WATCHER_NAME = 'org.kde.StatusNotifierWatcher';
const WATCHER_PATH = '/StatusNotifierWatcher';
const DEFAULT_ITEM_PATH = '/StatusNotifierItem';
const ITEM_NAME_REGEX = /^org\.(kde|freedesktop)\.StatusNotifierItem-/;

const WATCHER_INTERFACE = `<node>
<interface name="org.kde.StatusNotifierWatcher">
    <method name="RegisterStatusNotifierItem">
        <arg name="service" type="s" direction="in"/>
    </method>
    <method name="RegisterStatusNotifierHost">
        <arg name="service" type="s" direction="in"/>
    </method>
    <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
    <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
    <property name="ProtocolVersion" type="i" access="read"/>
    <signal name="StatusNotifierItemRegistered">
        <arg type="s"/>
    </signal>
    <signal name="StatusNotifierItemUnregistered">
        <arg type="s"/>
    </signal>
    <signal name="StatusNotifierHostRegistered"/>
    <signal name="StatusNotifierHostUnregistered"/>
</interface>
</node>`;


export class Watcher {
    constructor(logger) {
        this._logger = logger;
        this._indicators = new Map();
        this._cancellable = new Gio.Cancellable();

        this._dbus = Gio.DBusExportedObject.wrapJSObject(WATCHER_INTERFACE, this);
        this._dbus.export(Gio.DBus.session, WATCHER_PATH);

        this._nameId = Gio.DBus.session.own_name(WATCHER_NAME, Gio.BusNameOwnerFlags.NONE,
            () => this._dbus.emit_signal('StatusNotifierHostRegistered', null),
            () => this._logger.warn(`Could not own ${WATCHER_NAME}, is another tray host running?`));

        this._registerRunningItems();
    }

    get RegisteredStatusNotifierItems() {
        return [...this._indicators.keys()];
    }

    get IsStatusNotifierHostRegistered() {
        return true;
    }

    get ProtocolVersion() {
        return 0;
    }

    async RegisterStatusNotifierItemAsync([service], invocation) {
        const pathIndex = service.indexOf('/');
        const [name, path] =
            pathIndex < 0 ? [service, DEFAULT_ITEM_PATH]
                : pathIndex === 0 ? [invocation.get_sender(), service]
                    : [service.slice(0, pathIndex), service.slice(pathIndex)];

        try {
            await this._register(name, path);
            invocation.return_value(null);
        } catch (e) {
            this._logger.warn(`Could not register ${service}: ${e.message}`);
            invocation.return_dbus_error('org.freedesktop.DBus.Error.InvalidArgs', e.message);
        }
    }

    RegisterStatusNotifierHostAsync(_params, invocation) {
        invocation.return_error_literal(Gio.DBusError, Gio.DBusError.NOT_SUPPORTED,
            'Registering additional hosts is not supported');
    }

    async _registerRunningItems() {
        try {
            const reply = await Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
                'org.freedesktop.DBus', 'ListNames', null, new GLib.VariantType('(as)'),
                Gio.DBusCallFlags.NONE, -1, this._cancellable);
            const [names] = reply.deepUnpack();

            await Promise.allSettled(names.filter(name => ITEM_NAME_REGEX.test(name))
                .map(name => this._register(name, DEFAULT_ITEM_PATH)));
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                this._logger.error('Could not list the running items:', e);
        }
    }

    async _register(name, path) {
        if (!Gio.dbus_is_name(name) || !GLib.Variant.is_object_path(path))
            throw new Error('Invalid bus name or object path');

        const owner = Gio.dbus_is_unique_name(name) ? name : await this._getNameOwner(name);
        if (this._cancellable.is_cancelled())
            return;

        const id = `${owner}${path}`;
        const registered = this._indicators.get(id);
        if (registered) {
            registered.refresh();
            return;
        }

        const indicator = new Indicator(name, owner, path, this._logger);
        this._indicators.set(id, indicator);
        indicator.connect('destroy', () => {
            this._indicators.delete(id);
            this._notifyItemChange('StatusNotifierItemUnregistered', id);
        });

        Main.panel.addToStatusArea(`appindicator-${id}`, indicator, 1, 'right');
        this._notifyItemChange('StatusNotifierItemRegistered', id);
    }

    async _getNameOwner(name) {
        const reply = await Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'GetNameOwner', new GLib.Variant('(s)', [name]),
            new GLib.VariantType('(s)'), Gio.DBusCallFlags.NONE, -1, this._cancellable);
        const [owner] = reply.deepUnpack();

        return owner;
    }

    _notifyItemChange(signal, id) {
        this._dbus.emit_signal(signal, new GLib.Variant('(s)', [id]));
        this._dbus.emit_property_changed('RegisteredStatusNotifierItems',
            new GLib.Variant('as', this.RegisteredStatusNotifierItems));
    }

    destroy() {
        this._cancellable.cancel();
        [...this._indicators.values()].forEach(indicator => indicator.destroy());

        this._dbus.emit_signal('StatusNotifierHostUnregistered', null);
        Gio.DBus.session.unown_name(this._nameId);
        this._dbus.unexport();
    }
}

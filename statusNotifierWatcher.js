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

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as AppIndicator from './appIndicator.js';
import * as DBusUtils from './dbusUtils.js';
import * as Interfaces from './interfaces.js';
import * as PromiseUtils from './promiseUtils.js';
import * as Util from './util.js';
import {IndicatorStatusIcon} from './indicatorStatusIcon.js';

Gio._promisify(Gio.Subprocess.prototype, 'wait_check_async');

const WATCHER_BUS_NAME = 'org.kde.StatusNotifierWatcher';
const WATCHER_OBJECT = '/StatusNotifierWatcher';
const DEFAULT_ITEM_OBJECT_PATH = '/StatusNotifierItem';

/*
 * The StatusNotifierWatcher class implements the StatusNotifierWatcher dbus object
 */
export class StatusNotifierWatcher {
    constructor(extensionPath) {
        this._items = new Map();
        this._cancellable = new Gio.Cancellable();

        this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(
            Interfaces.StatusNotifierWatcher, this);
        this._dbusImpl.export(Gio.DBus.session, WATCHER_OBJECT);

        this._ownNameId = Gio.DBus.session.own_name(WATCHER_BUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            () => this._emitSignal('StatusNotifierHostRegistered'),
            () => console.warn(`AppIndicators: ${WATCHER_BUS_NAME} is not owned`));

        this._seekStatusNotifierItems(extensionPath).catch(e =>
            Util.logErrorUnlessCancelled(e, 'Looking for StatusNotifierItems'));
    }

    _emitSignal(name, parameters = null) {
        try {
            this._dbusImpl.emit_signal(name, parameters);
        } catch (e) {
            logError(e, `Failed to emit ${name}`);
        }
    }

    _notifyItemsChanged(signal, service) {
        this._emitSignal(signal, new GLib.Variant('(s)', [service ?? '']));

        try {
            this._dbusImpl.emit_property_changed('RegisteredStatusNotifierItems',
                new GLib.Variant('as', this.RegisteredStatusNotifierItems));
        } catch (e) {
            logError(e, 'Failed to notify the registered items');
        }
    }

    async _registerItem(service, busName, objectPath) {
        const id = Util.indicatorId(service, busName, objectPath);

        if (this._cancellable.is_cancelled())
            return;

        if (this._items.has(id)) {
            console.warn(`AppIndicators: item ${id} is already registered`);
            return;
        }

        console.debug(`AppIndicators: registering StatusNotifierItem ${id}`);

        const indicator = new AppIndicator.AppIndicator(service, busName, objectPath);
        this._items.set(id, indicator);

        indicator.connect('destroy', () => {
            this._items.delete(id);
            this._notifyItemsChanged('StatusNotifierItemUnregistered', indicator.service);
        });
        indicator.connect('name-owner-changed', () =>
            this._onIndicatorNameOwnerChanged(indicator).catch(e =>
                Util.logErrorUnlessCancelled(e)));

        try {
            // if the desktop is not ready delay the icon creation and signal emissions
            await Util.waitForStartupCompletion(indicator.cancellable);

            Main.panel.addToStatusArea(`appindicator-${id}`,
                new IndicatorStatusIcon(indicator), 1, 'right');
        } catch (e) {
            indicator.destroy();
            throw e;
        }

        this._notifyItemsChanged('StatusNotifierItemRegistered', service);
    }

    async _onIndicatorNameOwnerChanged(indicator) {
        if (indicator.hasNameOwner)
            return;

        // give the application a chance to come back (e.g. when restarting)
        await new PromiseUtils.TimeoutPromise(500, GLib.PRIORITY_DEFAULT,
            indicator.cancellable);

        if (!indicator.hasNameOwner)
            indicator.destroy();
    }

    async _ensureItemRegistered(service, busName, objectPath) {
        const item = this._items.get(Util.indicatorId(service, busName, objectPath));

        if (item) {
            console.debug(`AppIndicators: ${item.uniqueId} re-registered, resetting it`);
            item.reset();
            return;
        }

        await this._registerItem(service, busName, objectPath);
    }

    async _seekStatusNotifierItems(extensionPath) {
        // Some indicators (*coff*, dropbox, *coff*) do not re-register again
        // when the plugin is enabled/disabled, thus we need to manually look
        // for the objects in the session bus that implements the
        // StatusNotifierItem interface... However let's do it after a low
        // priority timeout, and using an external process so that it won't
        // affect startup or memory (as it seems that gjs is not great at
        // handling the memory of the bus analyzer async code).
        await new PromiseUtils.TimeoutSecondsPromise(2, GLib.PRIORITY_LOW,
            this._cancellable);

        const busAnalyzer = GLib.build_filenamev([extensionPath, 'tools', 'busAnalyzer.js']);
        const subprocess = Gio.Subprocess.new(['gjs', '-m', busAnalyzer],
            Gio.SubprocessFlags.STDOUT_PIPE);
        const stdout = new Gio.DataInputStream({base_stream: subprocess.get_stdout_pipe()});
        const textDecoder = new TextDecoder();

        try {
            // The items are registered as soon as they are found, as the
            // analyzer may wait for some unresponsive bus names
            for (;;) {
                // eslint-disable-next-line no-await-in-loop
                const [line] = await stdout.read_line_async(GLib.PRIORITY_LOW,
                    this._cancellable);
                if (line === null)
                    break;

                // GNOME Shell promisifies read_line_async() with read_line_finish()
                // eslint-disable-next-line no-await-in-loop
                await this._registerSeekedItem(typeof line === 'string'
                    ? line : textDecoder.decode(line));
            }

            await subprocess.wait_check_async(this._cancellable);
        } catch (e) {
            subprocess.force_exit();
            throw e;
        }
    }

    async _registerSeekedItem(json) {
        try {
            const {services, name, path} = JSON.parse(json);
            const ids = [null, ...services].map(s => Util.indicatorId(s, name, path));
            if (ids.some(id => this._items.has(id)))
                return;

            const service = services.find(s =>
                s.startsWith('org.kde.StatusNotifierItem')) ?? services[0];
            console.debug(`AppIndicators: using brute-force mode for ${name}${path}`);

            await this._registerItem(service, name, path);
        } catch (e) {
            Util.logErrorUnlessCancelled(e);
        }
    }

    async RegisterStatusNotifierItemAsync([service], invocation) {
        // it would be too easy if all application behaved the same
        // instead, ayatana patched gnome apps to send a path
        // while kde apps send a bus name
        let busName, objectPath;

        console.debug(`AppIndicators: registration request for service '${service}'`);
        const pathIndex = service.indexOf('/');

        try {
            if (pathIndex === 0) {
                // looks like a path
                busName = invocation.get_sender();
                objectPath = service;
            } else if (pathIndex > 0) {
                // Electron started another non-standard format: yay!
                // They're now providing the service name as first element,
                // followed by a DBus path. This is wrong, but not much we can
                // do about it.
                busName = await DBusUtils.getUniqueBusName(invocation.get_connection(),
                    service.slice(0, pathIndex), this._cancellable);
                objectPath = service.slice(pathIndex);
            } else if (DBusUtils.BUS_SNI_NAME_REGEX.test(service)) {
                // If the app uses a standard SNI name, use it as is, as some
                // apps (look at you electron!) rely on the bus name and match
                // rules to handle the requests.
                busName = service;
                objectPath = DEFAULT_ITEM_OBJECT_PATH;
            } else if (DBusUtils.BUS_ADDRESS_REGEX.test(service)) {
                busName = await DBusUtils.getUniqueBusName(invocation.get_connection(),
                    service, this._cancellable);
                objectPath = DEFAULT_ITEM_OBJECT_PATH;
            }

            if (!busName || !objectPath)
                throw new Error(`Impossible to register an indicator for parameters '${service}'`);

            await this._ensureItemRegistered(service, busName, objectPath);
            invocation.return_value(null);
        } catch (e) {
            Util.logErrorUnlessCancelled(e);
            invocation.return_dbus_error('org.gnome.gjs.JSError.ValueError', e.message);
        }
    }

    RegisterStatusNotifierHostAsync(_params, invocation) {
        invocation.return_error_literal(Gio.DBusError, Gio.DBusError.NOT_SUPPORTED,
            'Registering additional notification hosts is not supported');
    }

    get RegisteredStatusNotifierItems() {
        return [...this._items.values()].map(indicator => indicator.service ?? '');
    }

    get IsStatusNotifierHostRegistered() {
        return true;
    }

    get ProtocolVersion() {
        return 0;
    }

    destroy() {
        this._cancellable.cancel();
        this._items.forEach(indicator => indicator.destroy());

        this._emitSignal('StatusNotifierHostUnregistered');
        Gio.DBus.session.unown_name(this._ownNameId);
        this._dbusImpl.unexport();

        Util.destroyDefaultIconTheme();
    }
}

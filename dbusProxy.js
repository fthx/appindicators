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
import GObject from 'gi://GObject';

export const DBusProxy = GObject.registerClass(
class DBusProxy extends Gio.DBusProxy {
    _init(busName, objectPath, interfaceInfo, flags) {
        super._init({
            gConnection: Gio.DBus.session,
            gInterfaceName: interfaceInfo.name,
            gInterfaceInfo: interfaceInfo,
            gName: busName,
            gObjectPath: objectPath,
            gFlags: flags,
        });

        // Cancelled when the name owner vanishes or when destroyed
        this._cancellable = new Gio.Cancellable();

        this._signalIds = [
            this.connect('g-signal', (_proxy, ...args) => this._onSignal(...args)),
            this.connect('notify::g-name-owner', () => {
                if (!this.gNameOwner) {
                    this._cancellable.cancel();
                    this._cancellable = new Gio.Cancellable();
                }
                this._onNameOwnerChanged();
            }),
        ];
    }

    initAsync() {
        return this.init_async(GLib.PRIORITY_DEFAULT, this._cancellable);
    }

    destroy() {
        this._signalIds.forEach(id => this.disconnect(id));
        this._signalIds = [];
        this._cancellable.cancel();
    }

    _onSignal(_sender, _signal, _params) {
    }

    _onNameOwnerChanged() {
    }

    getProperty(propertyName, cancellable) {
        return this.gConnection.call(this.gName, this.gObjectPath,
            'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [this.gInterfaceName, propertyName]),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, -1,
            cancellable);
    }

    getProperties(cancellable) {
        return this.gConnection.call(this.gName, this.gObjectPath,
            'org.freedesktop.DBus.Properties', 'GetAll',
            new GLib.Variant('(s)', [this.gInterfaceName]),
            new GLib.VariantType('(a{sv})'), Gio.DBusCallFlags.NONE, -1,
            cancellable);
    }
});

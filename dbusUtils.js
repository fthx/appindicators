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

// This module is also used by the bus analyzer tool, out of GNOME Shell:
// it must not import any GNOME Shell module.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.DBusConnection.prototype, 'call');

export const BUS_ADDRESS_REGEX = /([a-zA-Z0-9._-]+\.[a-zA-Z0-9.-]+)|(:[0-9]+\.[0-9]+)$/;
export const BUS_SNI_NAME_REGEX = /^org\.freedesktop\.StatusNotifierItem-[0-9]+-[0-9]+$/;

function callBus(bus, method, params, replyType, cancellable) {
    return bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
        'org.freedesktop.DBus', method, params, new GLib.VariantType(replyType),
        Gio.DBusCallFlags.NONE, -1, cancellable);
}

export async function getUniqueBusName(bus, name, cancellable) {
    if (name[0] === ':')
        return name;

    const reply = await callBus(bus, 'GetNameOwner',
        new GLib.Variant('(s)', [name]), '(s)', cancellable);
    const [uniqueName] = reply.deepUnpack();
    return uniqueName;
}

export async function getProcessId(busName, cancellable) {
    const reply = await callBus(Gio.DBus.session, 'GetConnectionUnixProcessID',
        new GLib.Variant('(s)', [busName]), '(u)', cancellable);
    const [pid] = reply.deepUnpack();
    return pid;
}

// Maps each unique bus name to the set of well-known names it owns
export async function getBusNames(bus, cancellable) {
    const reply = await callBus(bus, 'ListNames', null, '(as)', cancellable);
    const [names] = reply.deepUnpack();
    const results = await Promise.allSettled(
        names.map(name => getUniqueBusName(bus, name, cancellable)));

    const busNames = new Map();
    results.forEach(({status, value: uniqueName}, i) => {
        if (status !== 'fulfilled')
            return;

        if (!busNames.has(uniqueName))
            busNames.set(uniqueName, new Set());

        if (uniqueName !== names[i])
            busNames.get(uniqueName).add(names[i]);
    });

    return busNames;
}

// Yields the paths of the objects implementing one of the interfaces
export async function* introspectBusObject(bus, name, interfaces, cancellable, path = '/') {
    const reply = await bus.call(name, path,
        'org.freedesktop.DBus.Introspectable', 'Introspect', null,
        new GLib.VariantType('(s)'), Gio.DBusCallFlags.NONE, 5000, cancellable);
    const [xml] = reply.deepUnpack();
    const nodeInfo = Gio.DBusNodeInfo.new_for_xml(xml);

    if (interfaces.some(iface => nodeInfo.lookup_interface(iface)))
        yield path;

    for (const {path: subPath} of nodeInfo.nodes) {
        yield* introspectBusObject(bus, name, interfaces, cancellable,
            `${path === '/' ? '' : path}/${subPath}`);
    }
}

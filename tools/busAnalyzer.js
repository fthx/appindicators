#!/usr/bin/env -S gjs -m

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

// Looks for the StatusNotifierItem objects of the session bus, and prints
// each of them as a JSON line: {services, name, path}

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import * as DBusUtils from '../dbusUtils.js';

const SNI_INTERFACES = ['org.kde.StatusNotifierItem'];

async function seekStatusNotifierItems() {
    const bus = Gio.DBus.session;
    const busNames = await DBusUtils.getBusNames(bus, null);

    await Promise.allSettled([...busNames].map(async ([name, wellKnownNames]) => {
        const services = [...wellKnownNames];

        for await (const path of DBusUtils.introspectBusObject(bus, name, SNI_INTERFACES, null))
            print(JSON.stringify({services, name, path}));
    }));
}

const loop = new GLib.MainLoop(null, false);
let exitCode = 0;

seekStatusNotifierItems().catch(e => {
    logError(e);
    exitCode = 1;
}).finally(() => loop.quit());

loop.run();
System.exit(exitCode);

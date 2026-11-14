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
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {BUS_ADDRESS_REGEX} from './dbusUtils.js';
import {SignalConnectionPromise} from './promiseUtils.js';

let logger = null;

// The messages are prefixed with the extension name
function getLogger() {
    logger ??= Extension.lookupByURL(import.meta.url)?.getLogger();
    return logger ?? console;
}

export function debug(message) {
    getLogger().debug(message);
}

export function warn(message) {
    getLogger().warn(message);
}

export function logError(error, message = 'Unexpected error') {
    getLogger().error(`${message}:`, error);
}

export function isCancelled(error) {
    return error instanceof GLib.Error &&
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

export function logErrorUnlessCancelled(error, message) {
    if (!isCancelled(error))
        logError(error, message);
}

export function indicatorId(service, busName, objectPath) {
    if (service !== busName && service?.match(BUS_ADDRESS_REGEX))
        return service;

    return `${busName}@${objectPath}`;
}

let defaultIconTheme = null;

export function getDefaultIconTheme() {
    defaultIconTheme ??= new St.IconTheme();
    return defaultIconTheme;
}

export function destroyDefaultIconTheme() {
    defaultIconTheme = null;
}

/**
 * Wait for the desktop startup to be completed: adding widgets before
 * the desktop is ready to accept them can result in errors.
 *
 * @param {Gio.Cancellable} cancellable Cancellation object for the wait.
 */
export async function waitForStartupCompletion(cancellable) {
    if (Main.layoutManager._startingUp) {
        await new SignalConnectionPromise(Main.layoutManager,
            'startup-complete', cancellable);
    }
}

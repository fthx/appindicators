// App Indicators @fthx
// Simplified and cleaned fork of Ubuntu's AppIndicators extension
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

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { StatusNotifierWatcher } from './statusNotifierWatcher.js';

export default class AppIndicatorsExtension extends Extension {
    enable() {
        this._watcher = new StatusNotifierWatcher(this.path);
    }

    disable() {
        // The watcher bus name is released synchronously, so the extension
        // can be enabled again right away (e.g. when unlocking the screen).
        this._watcher?.destroy();
        this._watcher = null;
    }
}

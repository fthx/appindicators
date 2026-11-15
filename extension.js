import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Watcher } from './watcher.js';


export default class AppIndicatorsExtension extends Extension {
    enable() {
        this._watcher = new Watcher(this.getLogger());
    }

    disable() {
        this._watcher?.destroy();
        this._watcher = null;
    }
}

/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */
/*
    Copyright (C) 2013  Philippe Normand.

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Shell = imports.gi.Shell;

const SessionSaver = new Lang.Class({
    Name: 'SessionSaver',

    _init: function() {
        this._cacheDir = GLib.get_user_cache_dir() + '/gnome-shell/';
        let dir = Gio.file_new_for_path(this._cacheDir);
        if (!dir.query_exists(null)) {
            GLib.mkdir_with_parents(this._cacheDir, 0x1c0); // 0x1c0 = octal 0700
        }
        this._cacheFile = 'session-state.json';
        this._appSys = Shell.AppSystem.get_default();
        this._windowTracker = Shell.WindowTracker.get_default();
        this._windowCreatedId = 0;
        this._state = {};
        this._restoredState = {};
        this._appStateChangeSignals = {};
    },

    destroy: function() {
        this.disable();
    },

    _windowCreated: function(display, window, noRecurse) {
        if (!this._windowTracker.is_window_interesting(window))
            return;

        let app = this._windowTracker.get_window_app(window);
        if (!app) {
            if (!noRecurse) {
                // window is not tracked yet.
                Mainloop.idle_add(Lang.bind(this, function() {
                    this._windowCreated(display, window, true);
                    return false;
                }));
            } else
                log ('Cannot find application for window');
            return;
        }

        this._trackApp(app, window);
    },

    _trackApp: function(app, window) {
        let appId = app.get_id();
        let workspace = window.get_workspace();
        let workspaceIndex = workspace.index();

        let apps = this._state[workspaceIndex];
        if (!apps)
            apps = {};
        else
            apps[appId] = '';

        this._state[workspaceIndex] = apps;
        this._syncJson();

        // TODO: connect to window::workspace-changed signal. params: old_workspace

        let win = window.get_compositor_private();
        let positionHandler = win.connect('position-changed',
                                          Lang.bind(this, this._onPositionChanged, appId));
        let sizeHandler = win.connect('size-changed',
                                      Lang.bind(this, this._onSizeChanged, appId));
        let stateHandler = app.connect('notify::state',
                                       Lang.bind(this,
                                                 this._onAppStateChanged, window));
        this._appStateChangeSignals[appId] = [stateHandler, positionHandler, sizeHandler];
        log("App " + appId + " in workspace " + workspaceIndex);
    },

    _onPositionChanged: function(windowActor, appId) {
        let window = windowActor.meta_window;
        let rect = window.get_outer_rect();
        let workspaceIndex = windowActor.get_workspace();
        this._updateWindowRect(workspaceIndex, appId, rect);
    },

    _onSizeChanged: function(windowActor, appId) {
        let rect = windowActor.meta_window.get_outer_rect();
        let workspaceIndex = windowActor.get_workspace();
        this._updateWindowRect(workspaceIndex, appId, rect);
    },

    _updateWindowRect: function(workspaceIndex, appId, rect) {
        let apps = this._state[workspaceIndex];
        if (!apps)
            return;
        apps[appId] = [rect.x, rect.y, rect.width, rect.height];
        this._state[workspaceIndex] = apps;
        this._syncJson();
    },

    _onAppStateChanged: function(app, paramSpec, window) {
        if (app.state == Shell.AppState.STOPPED)
            this._appStopped(app, window);
        if (app.state == Shell.AppState.RUNNING)
            this._appStarted(app, window);
    },

    _appStarted: function(app, window) {
        log("App %s now running".format(app.get_id()));
        let workspace = window.get_workspace();
        let workspaceIndex = workspace.index();
        let restoredApps = this._restoredState[workspaceIndex];
        if (!restoredApps)
            return;
        let appId = app.get_id();
        if (appId in restoredApps) {
            let coords = restoredApps[appId];
            if (coords) {
                delete this._restoredState[workspaceIndex][appId];
                Mainloop.idle_add(Lang.bind(this, function() {
                   window.move_resize_frame(true, coords[0], coords[1], coords[2], coords[3]);
                    return false;
                }));
            }
        }
    },

    _appStopped: function(app, window) {
        this._forgetApp(app, window);

        for (let j = 0; j <= global.screen.n_workspaces; j++) {
            let apps = this._state[j];
            if (!apps)
                continue;
            let appId = app.get_id();
            delete apps[appId];
        }
        this._syncJson();
    },

    _forgetApp: function(app, window) {
        let appId = app.get_id();
        let [stateHandler, positionHandler, sizeHandler] = this._appStateChangeSignals[appId];
        if (window) {
            let win = window.get_compositor_private();
            if (win) {
                win.disconnect(positionHandler);
                win.disconnect(sizeHandler);
            }
        }
        app.disconnect(stateHandler);
        delete this._appStateChangeSignals[appId];
    },

    _syncJson: function() {
        let file = this._cacheDir + this._cacheFile;
        let data = JSON.stringify(this._state);
        data += "\n";
        try {
            GLib.file_set_contents(file, data, data.length);
        } catch (e) {
            logError(e, 'Error caching session state');
        }
    },

    _readJson: function() {
        let dir = Gio.file_new_for_path(this._cacheDir);
        let file = dir.get_child(this._cacheFile);
        if (!file.query_exists(null))
            return {};

        [success, fileContent, tag] = file.load_contents(null);
        let dict;
        try {
            dict = JSON.parse(fileContent);
        } catch (err) {
            dict = {};
        }
        log("JSON: " + fileContent);
        return dict;
    },

    _restoreApps: function() {
        this._restoredState = this._readJson();
        if (!this._restoredState)
            return;

        for (let index = 0; index < global.screen.n_workspaces; index++) {
            let apps = this._restoredState[index];
            if (!apps)
                continue;
            for (let appId in apps) {
                let app = this._appSys.lookup_app(appId);
                if (!app)
                    continue;
                if (app.state == Shell.AppState.STOPPED)
                    app.open_new_window(index);
                else {
                    // FIXME: track all windows of the app.
                    let window = app.get_windows()[0];
                    this._trackApp(app, window);
                }
            }
        }
    },

    enable: function() {
        this._restoreApps();
        let display = global.screen.get_display();
        this._windowCreatedId = display.connect_after('window-created',
                                                      Lang.bind(this,
                                                                this._windowCreated));
    },

    disable: function() {
        for (let workspaceIndex in this._state) {
            let apps = this._state[workspaceIndex];
            if (!apps)
                continue;
            for (let appId in apps) {
                let app = this._appSys.lookup_app(appId);
                if (!app)
                    continue;
                this._forgetApp(app, null);
            }
        }
        this._state = {};
        this._restoreApps = {};
        if (this._windowCreatedId) {
            global.screen.get_display().disconnect(this._windowCreatedId);
            this._windowCreatedId = 0;
        }
    }
});

function init() {
    return new SessionSaver();
}

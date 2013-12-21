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
        this._cacheFile = 'session-state.json';
        this._appSys = Shell.AppSystem.get_default();
        this._windowTracker = Shell.WindowTracker.get_default();
        this._windowCreatedId = 0;
        this._state = {};
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
            apps = [appId,];
        else
            apps.push(appId);
        this._state[workspaceIndex] = apps;
        this._syncJson();

        let handler = app.connect('notify::state',
                                  Lang.bind(this,
                                            this._onAppStateChanged, app));
        this._appStateChangeSignals[appId] = handler;
        log("App " + appId + " in workspace " + workspaceIndex);
    },

    _onAppStateChanged: function(app) {
        if (app.state != Shell.AppState.STOPPED)
            return;

        let appId = app.get_id();
        let handler = this._appStateChangeSignals[appId];
        app.disconnect(handler);
        delete this._appStateChangeSignals[appId];

        for (let j = 0; j <= global.screen.n_workspaces; j++) {
            let apps = this._state[j];
            if (!apps)
                continue;
            if (apps.indexOf(appId) !== -1)
                apps.splice(appId, 1);
        }
        this._syncJson();
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
        let state = this._readJson();
        if (!state)
            return;

        for (let index = 0; index < global.screen.n_workspaces; index++) {
            let apps = state[index];
            if (!apps)
                continue;
            for (let appIndex = 0; appIndex < apps.length; appIndex++) {
                let appId = apps[appIndex];
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
        this._state = {};
        if (this._windowCreatedId) {
            global.screen.get_display().disconnect(this._windowCreatedId);
            this._windowCreatedId = 0;
        }
    }
});

function init() {
    return new SessionSaver();
}

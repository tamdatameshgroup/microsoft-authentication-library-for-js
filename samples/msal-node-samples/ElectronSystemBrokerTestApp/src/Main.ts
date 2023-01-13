/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { IpcMessages, GRAPH_CONFIG, APPLICATION_DIMENSIONS } from "./Constants";
import * as authConfig from "./config/customConfig.json";
import AuthProvider from "./AuthProvider";
import { FetchManager } from "./FetchManager";
import { AccountInfo } from "@azure/msal-node";
import * as path from "path";

// This allows TypeScript to pick up the magic constants that's auto-generated by Forge's Webpack
// plugin that tells the Electron app where to look for the Webpack-bundled app code (depending on
// whether you're running in development or production).
declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

export default class Main {
    static application: Electron.App;
    static mainWindow: Electron.BrowserWindow;
    static authProvider: AuthProvider;
    static fetchManager: FetchManager;
    static authConfig: any;

    static main(): void {
        Main.application = app;
        Main.application.on("window-all-closed", Main.onWindowAllClosed);
        Main.setDefaultProtocol();
        Main.requestSingleInstance();

        // if in automation, read the config from environment
        Main.authConfig = process.env.authConfig
            ? JSON.parse(process.env.authConfig)
            : authConfig;
    }

    private static setDefaultProtocol(): void {
        if (process.defaultApp) {
            if (process.argv.length >= 2) {
                Main.application.setAsDefaultProtocolClient(
                    authConfig.customProtocol.name,
                    process.execPath,
                    [path.resolve(process.argv[1])]
                );
            } else {
                Main.application.setAsDefaultProtocolClient(
                    authConfig.customProtocol.name
                );
            }
        }
    }

    private static onWindowAllClosed(): void {
        // Windows and Linux will quit the application when all windows are closed. In macOS requires explicit quitting
        if (process.platform !== "darwin") {
            Main.application.quit();
        } 
    }

    private static requestSingleInstance(): void {
        // Prevent private URI scheme notifications on Windows + Linux from creating a new instance of the application
        const gotTheLock = app.requestSingleInstanceLock();
        if (!gotTheLock) {
            Main.application.quit();
        } else {
            Main.application.on("second-instance", Main.onSecondInstance);
            Main.application.on("ready", Main.onReady);
            Main.application.on("open-url", Main.onOpenUrl);
        }
    }

    private static onSecondInstance(event: any): void {
        event.preventDefault();
        Main.handleWindowState();
    }

    /**
     * On macOS, this is where we receive login responses
     */
    private static onOpenUrl(event: any): void {
        event.preventDefault();
        Main.handleWindowState();
    }

    /**
     * This method should focus on our window when running a Second instance of the app
     */
    private static handleWindowState(): void {
        // Someone tried to run a second instance, we should focus our window.
        if (Main.mainWindow) {
            if (Main.mainWindow.isMinimized()) {
                Main.mainWindow.restore();
            } 
            Main.mainWindow.focus();
        }
    }

    private static onReady(): void {
        Main.createMainWindow();
        Main.mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
        Main.mainWindow.on("closed", Main.onClose);
        Main.authProvider = new AuthProvider(Main.authConfig);
        Main.fetchManager = new FetchManager();
        Main.registerSubscriptions();
        Main.attemptSSOSilent();
    }

    private static onClose(): void {
        Main.mainWindow = null;
    }

    // Creates main application window
    private static createMainWindow(): void {
        this.mainWindow = new BrowserWindow({
            width: APPLICATION_DIMENSIONS.WIDTH,
            height: APPLICATION_DIMENSIONS.HEIGHT,

            /**
             * Preload script serves as an interface between the Main process
             * that has access to Node API and the Renderer process which controls
             * the user interface but is otherwise not trustworthy of directly handling
             * the Node API.
             */
            webPreferences: {
                preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
                nodeIntegration: false,
            },
        });
    }

    private static publish(message: string, payload: any): void {
        Main.mainWindow.webContents.send(message, payload);
    }

    
    private static async attemptSSOSilent(): Promise<void> {
        const tokenRequest = {
            scopes: authConfig.resourceApi.scopes,
            account: null as AccountInfo,
        };
        const account = await Main.authProvider.loginSilent(tokenRequest);
        await Main.loadBaseUI();

        if (account) {
            console.log("Successful silent account retrieval");
            Main.publish(IpcMessages.SHOW_WELCOME_MESSAGE, account);
        }
    }

    private static async loadBaseUI(): Promise<void> {
        await Main.mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
    }

    private static async login(): Promise<void> {
        try {
            const account = await Main.authProvider.login();
            if (account) {
                await Main.loadBaseUI();
                Main.publish(IpcMessages.SHOW_WELCOME_MESSAGE, account);
            }
        } catch (error) {
            console.log(error);
        }
    }

    private static async getProfile(): Promise<void> {
        const tokenRequest = {
            account: null as AccountInfo,
            scopes: ["User.Read"],
        };
        const tokenResponse = await Main.authProvider.getToken(tokenRequest);
        const account = Main.authProvider.currentAccount();
        await Main.loadBaseUI();
        Main.publish(IpcMessages.SHOW_WELCOME_MESSAGE, account);
        const graphResponse = await Main.fetchManager.callEndpointWithToken(
            `${Main.authConfig.resourceApi.endpoint}${GRAPH_CONFIG.GRAPH_ME_ENDPT}`,
            tokenResponse.accessToken
        );
        Main.publish(IpcMessages.SET_PROFILE, graphResponse);
    }

    private static async getProfileInteractive(): Promise<void> {
        const tokenRequest = {
            account: null as AccountInfo,
            scopes: ["User.Read"],
            prompt: "login",
            windowHandle: Main.mainWindow.getNativeWindowHandle()
        };
        const tokenResponse = await Main.authProvider.getTokenInteractive(tokenRequest);
        const account = Main.authProvider.currentAccount();
        await Main.loadBaseUI();
        Main.publish(IpcMessages.SHOW_WELCOME_MESSAGE, account);
        const graphResponse = await Main.fetchManager.callEndpointWithToken(
            `${Main.authConfig.resourceApi.endpoint}${GRAPH_CONFIG.GRAPH_ME_ENDPT}`,
            tokenResponse.accessToken
        );
        Main.publish(IpcMessages.SET_PROFILE, graphResponse);
    }

    private static async getMail(): Promise<void> {
        const tokenRequest = {
            account: null as AccountInfo,
            scopes: ["Mail.Read"],
        };
        const tokenResponse = await Main.authProvider.getToken(tokenRequest);
        const account = Main.authProvider.currentAccount();
        await Main.loadBaseUI();
        Main.publish(IpcMessages.SHOW_WELCOME_MESSAGE, account);
        const graphResponse = await Main.fetchManager.callEndpointWithToken(
            `${Main.authConfig.resourceApi.endpoint}${GRAPH_CONFIG.GRAPH_MAIL_ENDPT}`,
            tokenResponse.accessToken
        );    
        Main.publish(IpcMessages.SET_MAIL, graphResponse);
    }

    private static async logout(): Promise<void> {
        await Main.authProvider.logout();
        await Main.loadBaseUI();
        Main.mainWindow.focus();
    }

    // Router that maps callbacks/actions to specific messages received from the Renderer
    private static registerSubscriptions(): void {
        ipcMain.on(IpcMessages.LOGIN, Main.login);
        ipcMain.on(IpcMessages.GET_PROFILE, Main.getProfileInteractive);
        ipcMain.on(IpcMessages.GET_MAIL, Main.getMail);
        ipcMain.on(IpcMessages.LOGOUT, Main.logout);
    }
}

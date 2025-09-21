import axios from "axios";
import config from '../config.json';
import Server from "./Server"
import * as https from "node:https";

const API_BASE_URL = config.remote + '/api/nodes/helper';
//como ignorar sel-signed certificate

const api = axios.create({ baseURL: API_BASE_URL,   httpsAgent: new https.Agent({
        rejectUnauthorized: false
    }) });


export async function VerifySFTP(userName: string, password: string, server: Server) {
    try {
        const response = await api.post('/verify-sftp', {
            userName: userName,
            password: password,
            serverUuid: server.id,
            token: config.token
        })
        return response.data.permission as boolean;
    } catch (e) {
        console.error('Error verifying SFTP:', e);
        return false;
    }
}

export async function userIsAdmin(userUuid: string) {
    try {
        const response = await api.post('/admin-permission', {
            token: config.token,
            userUuid: userUuid
        })
        return response.data.isAdmin;
    } catch (e) {
        console.error('Error checking admin permission:', e);
        return false;
    }
}

export async function hasPermission(userUuid: string, server: Server) {
    try {
        const response = await api.post('/permission', {
            token: config.token,
            userUuid: userUuid,
            serverUuid: server.id
        })
        return response.data.permission as boolean;
    } catch (e) {
        console.error('Error checking admin permission:', e);
        return false;
    }
}
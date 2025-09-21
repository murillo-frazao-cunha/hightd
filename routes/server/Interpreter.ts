import {FastifyReply, FastifyRequest} from "fastify";
import CreateServer from "./Create"
import GetServerStatus from "./Status";
import SendActionServer from "./Action";
import GetServerUsage from "./Usage";
import DeleteServer from "./Delete";
import { interpretFileManager } from './filemanager/FileManagerRoutes';
export async function interpretServers(request: FastifyRequest,
                                       reply: FastifyReply,
                                       params: { [key: string]: string }) {

    const { action } = params;

    if(action && action.startsWith('filemanager')) {
        const parts = action.split('/');
        // parts[0] = filemanager, parts[1] = subAction
        const sub = parts[1] || 'list';
        return interpretFileManager(request, reply, sub);
    }

    switch (action) {
        case "delete":
            return DeleteServer(request, reply)
        case "status":
            return GetServerStatus(request, reply)
        case "action":
            return SendActionServer(request, reply)
        case "usage":
            return GetServerUsage(request, reply)
        case "create":
        default:
            return CreateServer(request, reply);
    }

}
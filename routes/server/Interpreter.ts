import {FastifyReply, FastifyRequest} from "fastify";
import CreateServer from "./Create"
import GetServerStatus from "./Status";
import SendActionServer from "./Action";
import GetServerUsage from "./Usage";
import DeleteServer from "./Delete";
export async function interpretServers(request: FastifyRequest,
                                       reply: FastifyReply,
                                       params: { [key: string]: string }) {

    const { action } = params;

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
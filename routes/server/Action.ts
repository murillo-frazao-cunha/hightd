import {FastifyReply, FastifyRequest} from "fastify";
import {hasPermission} from "../../libs/RemoteConnect";
import {ServerModel} from "../../database/model/ServerModel";
import config from "./../../config.json";
import Server from "../../libs/Server";
import {StartData} from "../../types/ServerTypes";
// Função modificada
export default async function SendActionServer(request: FastifyRequest, reply: FastifyReply) {
    const body = request.body as any;
    if(!body.token) {
        return reply.status(400).send({ error: 'Token is required' });
    }
    if(body.token !== config.token) {
        return reply.status(403).send({ error: 'Invalid token' });
    }

    if(!body.serverId) {
        return  reply.status(400).send({ error: 'serverId is required' });
    }
    if(!body.userUuid) {
        return reply.status(400).send({ error: 'userUuid is required' });
    }

    const server = Server.getServer(body.serverId)
    if(!server) {
        return reply.status(404).send({ error: 'Server not found' });
    }
    const permission = await hasPermission(body.userUuid, server)
    if(!permission) {
        return reply.status(403).send({error: "No permission"})
    }
    const action = body.action;
    if(!action) {
        return reply.status(400).send({ error: 'action is required' });
    }

    switch (action) {
        case "start":
        case "restart": {
            const {
                memory,
                cpu,
                disk,
                environment,
                primaryAllocation,
                additionalAllocation,
                image,
                core
            } = body;

            if (
                memory === undefined ||
                cpu === undefined ||
                disk === undefined ||
                !environment ||
                !primaryAllocation ||
                !image ||
                !additionalAllocation ||
                !core
            ) {
                //verificar qual que tá faltando
                // copilot faz isso melhor
                console.log("Missing fields:", {
                    memory,
                    cpu,
                    disk,
                    environment,
                    primaryAllocation,
                    additionalAllocation,
                    image,
                    core
                });
                return reply.status(400).send({ error: 'Missing required fields for starting/restarting the server' });
            }
            const startData: StartData = {
                memory,
                cpu,
                disk,
                environment,
                primaryAllocation,
                additionalAllocations: additionalAllocation || [],
                image,
                core
            };
            console.log("Starting/Restarting server with data:", startData);
            if (action === "start") {
                server.start(startData);
            } else {
                server.restart(startData);
            }
            break;
        }
        case "stop": {
            const { command } = body;
            if (!command) {
                return reply.status(400).send({ error: 'command is required for action "stop"' });
            }
            server.stop({ command });
            break;
        }
        case "kill":
            server.kill();
            break;
        case "command":
            if (!body.command) {
                return reply.status(400).send({ error: 'command is required for action "command"' });
            }
            console.log(body.command)
            server.sendCommand(body.command);
            break
        default:
            return reply.status(400).send({ error: 'Invalid action' });
    }

    return reply.send({status: 'success'})
}
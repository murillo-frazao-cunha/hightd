import {FastifyReply, FastifyRequest} from "fastify";
import {hasPermission} from "../../libs/RemoteConnect";
import config from "./../../config.json";
import Server from "../../libs/Server";

export default async function GetServerUsage(request: FastifyRequest, reply: FastifyReply) {
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

    const usage = await server.getUsages();
    const memoryPercent = usage.memoryLimit > 0 ? (usage.memory / usage.memoryLimit) * 100 : 0;

    return reply.send({
        status: 'success',
        usage: {
            cpu: usage.cpu,
            memory: usage.memory,
            memoryLimit: usage.memoryLimit,
            memoryPercent,
            networkIn: usage.networkIn,
            networkOut: usage.networkOut,
            disk: usage.disk,
            startedAt: server.getStartedAt(),
            uptimeMs: server.getUptimeMs(),
            state: await server.getStatus()
        }
    })
}

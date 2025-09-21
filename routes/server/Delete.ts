import {FastifyReply, FastifyRequest} from "fastify";
import {userIsAdmin} from "../../libs/RemoteConnect";
import {ServerModel} from "../../database/model/ServerModel";
import config from "./../../config.json";
import Server from "../../libs/Server";

export default async function DeleteServer(request: FastifyRequest, reply: FastifyReply) {
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
    const isAdmin = await userIsAdmin(body.userUuid)

    if(!isAdmin) {
        return reply.status(403).send({error: "Not admin"})
    }

    const server = Server.getServer(body.serverId)
    if(!server) {
        return reply.status(404).send({error: "Server not found"})
    }
    try {
        server.delete(); // ponto e vírgula evita tentativa de chamada sobre o retorno void
        const model = await ServerModel.get("serverId", body.serverId);
        if (model) {
            await model.delete();
        }

    } catch (e) {
        console.error(e)
    }

    return reply.send({status: 'success'})
}
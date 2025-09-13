import {FastifyReply, FastifyRequest} from "fastify";
import {userIsAdmin} from "../../libs/RemoteConnect";
import {ServerModel} from "../../database/model/ServerModel";
import config from "./../../config.json";
import Server from "../../libs/Server";

export default async function CreateServer(request: FastifyRequest, reply: FastifyReply) {
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

    try {
        await ServerModel.create({
            serverId: body.serverId
        })
        await Server.create(body.serverId)
    } catch (e) {
        console.error(e)
    }

    return reply.send({status: 'success'})
}
import {FastifyReply, FastifyRequest} from "fastify";
import config from "./../../config.json";

export default function VerifyStatus(request: FastifyRequest, reply: FastifyReply) {
    const body = request.body as { token: string };
    if(body.token !== config.token) {
        return reply.status(401).send({status: 'error'});
    }
    return reply.status(200).send({status: 'success'});
}
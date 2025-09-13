
// --- TIPOS ---
// Define o formato de uma função que manipula uma rota da API.
import {FastifyReply, FastifyRequest} from "fastify";
import VerifyStatus from "./status/Status";
import {interpretServers} from "./server/Interpreter";

type ApiHandler = (
    request: FastifyRequest,
    reply: FastifyReply,
    params: { [key: string]: string }
) => Promise<any> | any;

// Define a estrutura de cada rota da API.
// Em vez de 'component', temos os métodos HTTP (GET, POST, etc.).
export interface RouteConfig {
    pattern: string;
    GET?: ApiHandler;
    POST?: ApiHandler;
    PUT?: ApiHandler;
    DELETE?: ApiHandler;
    // Adicione outros métodos se precisar (PATCH, HEAD, etc.)
}

export const apiRoutes: RouteConfig[] = [
    {
        pattern: '/api/v1/status',
        POST: VerifyStatus
    },
    {
        pattern: '/api/v1/servers/[[...action]]',
        POST: interpretServers,
        GET: interpretServers
    }
];


// --- FUNÇÃO DE MATCHING (Lógica do Roteador) ---
// Esta função é quase idêntica à das páginas, mas para a API.
export function findMatchingApiRoute(pathname: string) {
    for (const route of apiRoutes) {
        const regexPattern = route.pattern
            .replace(/\/\[\[\.\.\.(\w+)\]\]/g, '(\/(?<$1>.*))?')
            .replace(/\/\[\[(\w+)\]\]/g, '(\/(?<$1>[^/]+))?')
            .replace(/\[(\w+)\]/g, '(?<$1>[^/]+)');

        const regex = new RegExp(`^${regexPattern}/?$`);
        const match = pathname.match(regex);

        if (match) {
            return {
                route,
                params: match.groups || {}
            };
        }
    }
    return null;
}

export async function handleRequest(
    request: FastifyRequest,
    reply: FastifyReply
) {
    const { pathname } = new URL(request.url, `http://${request.headers.host}`);
    const method = request.method as keyof typeof apiRoutes[0]; // "GET" | "POST" | ...

    const match = findMatchingApiRoute(pathname);

    if (!match) {
        return reply.code(404).send({
            message: `A rota ${pathname} não foi encontrada.`
        });
    }

    // Verifica se a rota encontrada tem handler para o método
    const handler = match.route[method];

    if (handler && typeof handler === "function") {
        try {
            return await handler(request, reply, match.params);
        } catch (err: any) {
            request.log.error(err);
            return reply.code(500).send({
                message: "Erro interno do servidor",
                error: err.message
            });
        }
    }

    // Se a rota existe, mas não suporta o método usado
    return reply.code(405).send({
        message: `Método ${method} não permitido para a rota ${pathname}.`
    });
}
export interface CoreData {
    id: string;
    installScript: string;
    configSystem: Record<string, any>;
    stopCommand: string;
    startupCommand: string;
    name: string;
    startupParser: Record<string, any>;
    dockerImages: Array<{
        name: string;
        image: string;
    }>;
    variables: Array<{
        name: string;
        description: string;
        envVariable: string;
        rules: string;
    }>;
}

export interface StartData {
    memory: number
    cpu: number
    disk: number
    environment: any
    primaryAllocation: AllocationData
    additionalAllocations: AllocationData[]
    image: string
    core: CoreData
}
// 1. Interface para os dados da Alocação
export interface AllocationData {
    nodeId: string;
    ip: string;
    externalIp: string | null;
    port: number;
    assignedTo: string | null; // UUID do servidor ao qual está atribuída, ou null se não estiver atribuída
}
export interface StopData {
    command: string
}
// 1. Defina seus Models
import {BaseModel, Column, Table} from "../SQLite";

@Table('servers')
export class ServerModel extends BaseModel {
    @Column({ type: 'INTEGER', primaryKey: true, autoIncrement: true })
    id!: number;

    @Column({ type: 'TEXT' })
    serverId!: string;

}
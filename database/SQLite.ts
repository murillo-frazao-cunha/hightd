/**
 * Super-ORM-SQLite
 * Uma poderosa biblioteca ORM para SQLite em Node.js com TypeScript.
 * Zero SQL, tudo baseado em Models e funções.
 *
 * @author Gemini
 * @version 1.0.2
 */

// Importa a dependência principal. Instale com: npm install better-sqlite3
// E os types: npm install --save-dev @types/better-sqlite3
import Database, { Database as DB } from 'better-sqlite3';

// --- TIPOS E INTERFACES ---

/**
 * Opções para a anotação @Column.
 */
type ColumnOptions = {
    type: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' | 'BOOLEAN' | 'DATE';
    primaryKey?: boolean;
    autoIncrement?: boolean;
};

/**
 * Armazena o schema (tabela e colunas) de cada Model.
 */
const schemaRegistry = new Map<any, {
    tableName: string;
    columns: Map<string, ColumnOptions>;
    primaryKey: string;
}>();

// Interface auxiliar para tipar corretamente o "this" dos métodos estáticos
interface BaseModelConstructor<T extends BaseModel> {
    new (data?: Record<string, any>): T;
    db: DB;
}

// --- DECORATORS ---

/**
 * Decorator de classe para definir o nome da tabela no banco de dados.
 * @param tableName O nome da tabela.
 */
export function Table(tableName: string) {
    return function (value: Function, _context?: any) {
        const constructor = value;
        const schema = schemaRegistry.get(constructor) || { tableName: '', columns: new Map<string, ColumnOptions>(), primaryKey: '' };
        schema.tableName = tableName;
        schemaRegistry.set(constructor, schema as any);
    };
}

/**
 * Decorator de propriedade para mapear uma propriedade da classe para uma coluna da tabela.
 * @param options As opções da coluna (tipo, chave primária, etc).
 */
export function Column(options: ColumnOptions) {
    return function (target: any, propertyKey: string) {
        const ctor = target.constructor;
        const schema = schemaRegistry.get(ctor) || { tableName: '', columns: new Map<string, ColumnOptions>(), primaryKey: '' };
        schema.columns.set(propertyKey, options);
        if (options.primaryKey) schema.primaryKey = propertyKey;
        schemaRegistry.set(ctor, schema as any);
    };
}


// --- CLASSE BASE DO MODEL ---

export class BaseModel {
    static db: DB;

    // Rastreia se o objeto é uma nova linha ou uma já existente
    private _isNew: boolean = true;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(data?: Record<string, any>) {
        if (data) {
            Object.assign(this, data);
            this._isNew = false; // Se veio com dados, não é novo
        }
    }

    /**
     * Injeta a instância do banco de dados no Model para que ele possa executar queries.
     * @param databaseInstance A instância do better-sqlite3.
     */
    public static useDatabase(databaseInstance: DB) {
        this.db = databaseInstance;
    }

    /**
     * Salva a instância atual no banco de dados.
     * Cria um novo registro (INSERT) se for novo, ou atualiza um existente (UPDATE).
     */
    public async save(): Promise<void> {
        const schema = schemaRegistry.get(this.constructor);
        if (!schema) throw new Error(`Model ${this.constructor.name} não está registrado. Use os decorators @Table e @Column.`);

        // CORREÇÃO: Acessar a propriedade estática 'db' a partir do construtor da instância atual (ex: ServerModel.db)
        const db = (this.constructor as typeof BaseModel).db;
        if (!db) throw new Error(`A conexão com o banco de dados não foi inicializada para o Model ${this.constructor.name}. Você chamou orm.init()?`);

        const { tableName, columns, primaryKey } = schema;

        const allColumnNames = Array.from(columns.keys());
        // Para INSERT remover PK autoIncrement se não houver valor definido
        const insertColumnNames = allColumnNames.filter(c => {
            if (c === primaryKey) {
                const col = columns.get(c);
                if (col?.autoIncrement && (this[c] === undefined || this[c] === null)) return false;
            }
            return true;
        });

        const convertValue = (val: any) => {
            if (typeof val === 'boolean') return val ? 1 : 0;
            if (val instanceof Date) return val.toISOString();
            return val;
        };

        if (this._isNew) {
            // --- Lógica de INSERT ---
            const placeholders = insertColumnNames.map(() => '?').join(', ');
            const sql = `INSERT INTO ${tableName} (${insertColumnNames.join(', ')}) VALUES (${placeholders})`;

            const values = insertColumnNames.map(key => convertValue(this[key]));
            const stmt = db.prepare(sql); // <-- CORRIGIDO
            const info = stmt.run(...values);

            if (primaryKey && columns.get(primaryKey)?.autoIncrement && (this[primaryKey] === undefined || this[primaryKey] === null)) {
                this[primaryKey] = info.lastInsertRowid;
            }
            this._isNew = false;

        } else {
            // --- Lógica de UPDATE ---
            const setClause = allColumnNames.filter(c => c !== primaryKey).map(c => `${c} = ?`).join(', ');
            const sql = `UPDATE ${tableName} SET ${setClause} WHERE ${primaryKey} = ?`;

            const updateValues = allColumnNames
                .filter(c => c !== primaryKey)
                .map(key => convertValue(this[key]));

            updateValues.push(this[primaryKey]);

            const stmt = db.prepare(sql); // <-- CORRIGIDO
            stmt.run(...updateValues);
        }
    }

    /**
     * Deleta o registro atual do banco de dados.
     */
    public async delete(): Promise<void> {
        const schema = schemaRegistry.get(this.constructor);
        if (!schema) throw new Error(`Model ${this.constructor.name} não está registrado.`);

        // CORREÇÃO: Acessar a propriedade estática 'db' a partir do construtor da instância atual
        const db = (this.constructor as typeof BaseModel).db;
        if (!db) throw new Error(`A conexão com o banco de dados não foi inicializada para o Model ${this.constructor.name}. Você chamou orm.init()?`);

        const { tableName, primaryKey } = schema;
        const pkValue = this[primaryKey];

        if (this._isNew || !pkValue) {
            throw new Error("Não é possível deletar um registro que ainda não foi salvo ou não tem chave primária.");
        }

        const sql = `DELETE FROM ${tableName} WHERE ${primaryKey} = ?`;
        const stmt = db.prepare(sql); // <-- CORRIGIDO
        stmt.run(pkValue);
    }

    /**
     * Busca um único registro no banco de dados.
     * @param field O campo para a busca (ex: 'id').
     * @param value O valor a ser procurado.
     * @returns Uma instância do Model ou null se não for encontrado.
     */
    public static async get<T extends BaseModel>(this: BaseModelConstructor<T>, field: string, value: any): Promise<T | null> {
        const schema = schemaRegistry.get(this);
        if (!schema) throw new Error(`Model ${this.name} não está registrado.`);

        const sql = `SELECT * FROM ${schema.tableName} WHERE ${field} = ? LIMIT 1`;
        const stmt = this.db.prepare(sql);
        const row = stmt.get(value);

        return row ? new this(row) : null;
    }

    /**
     * Busca todos os registros que correspondem a uma condição.
     * Se nenhum critério for passado, age como getAll().
     * @param field O campo para a busca.
     * @param value O valor a ser procurado.
     * @returns Um array de instâncias do Model.
     */
    public static async find<T extends BaseModel>(this: BaseModelConstructor<T>, field?: string, value?: any): Promise<T[]> {
        const schema = schemaRegistry.get(this);
        if (!schema) throw new Error(`Model ${this.name} não está registrado.`);

        let sql = `SELECT * FROM ${schema.tableName}`;
        let rows;

        if (field && value !== undefined) {
            sql += ` WHERE ${field} = ?`;
            const stmt = this.db.prepare(sql);
            rows = stmt.all(value);
        } else {
            const stmt = this.db.prepare(sql);
            rows = stmt.all();
        }

        return rows.map((row: any) => new this(row));
    }

    /**
     * Busca todos os registros da tabela.
     * @returns Um array com todas as instâncias do Model.
     */
    public static async getAll<T extends BaseModel>(this: BaseModelConstructor<T>): Promise<T[]> {
        const schema = schemaRegistry.get(this);
        if (!schema) throw new Error(`Model ${this.name} não está registrado.`);

        const sql = `SELECT * FROM ${schema.tableName}`;
        const stmt = this.db.prepare(sql);
        const rows = stmt.all();

        return rows.map((row: any) => new this(row));
    }


    /**
     * Cria e já salva um novo registro no banco de dados.
     * @param data Os dados para o novo registro.
     * @returns A instância do Model recém-criada e salva.
     */
    public static async create<T extends BaseModel>(this: BaseModelConstructor<T>, data: Record<string, any>): Promise<T> {
        const instance = new this();
        Object.assign(instance, data);
        await (instance as any).save();
        return instance;
    }
}

// --- CLASSE PRINCIPAL DO BANCO DE DADOS ---

export class SuperORM {
    private db: DB;
    private models: (typeof BaseModel)[] = [];

    /**
     * @param path Caminho para o arquivo do banco de dados SQLite. ':memory:' para em memória.
     */
    constructor(path: string = ':memory:') {
        this.db = new Database(path); // Removido o verbose para não poluir o console
    }

    /**
     * Registra um ou mais models e inicializa as tabelas no banco de dados.
     * @param models Os modelos a serem registrados.
     */
    public async init(...models: (typeof BaseModel)[]) {
        this.models = models;
        for (const model of this.models) {
            this.createTableForModel(model);
            model.useDatabase(this.db); // Injeta a conexão no model
        }
        console.log('Banco de dados e tabelas inicializados com sucesso!');
    }

    /**
     * Cria a tabela para um model específico se ela não existir.
     * @param model O model para o qual a tabela será criada.
     */
    private createTableForModel(model: typeof BaseModel) {
        const schema = schemaRegistry.get(model);
        if (!schema) {
            console.warn(`Model ${model.name} não possui schema definido com @Table. Pulando.`);
            return;
        }

        const { tableName, columns } = schema;
        const columnDefinitions: string[] = [];

        for (const [prop, options] of columns.entries()) {
            let def = `${prop} ${options.type}`;
            if (options.primaryKey) def += ' PRIMARY KEY';
            if (options.autoIncrement) def += ' AUTOINCREMENT';
            columnDefinitions.push(def);
        }

        const sql = `CREATE TABLE IF NOT EXISTS ${tableName} (${columnDefinitions.join(', ')})`;
        this.db.exec(sql);
    }
}

import { s } from '@/util/escape';
import { extractManyToManyModels } from '@/util/extract-many-to-many-models';
import { UnReadonlyDeep } from '@/util/un-readonly-deep';
import { convertCase } from '@/util/casing';
import { type DMMF, GeneratorError, type GeneratorOptions } from '@prisma/generator-helper';
import path from 'path';

const pgImports = new Set<string>();
const drizzleImports = new Set<string>();
pgImports.add('pgTable');

const prismaToDrizzleType = (type: string, colExpr: string, defVal?: string) => {
	switch (type.toLowerCase()) {
		case 'bigint':
			pgImports.add('bigint');
			return `bigint(${[colExpr, "{ mode: 'bigint' }"].filter(Boolean).join(', ')})`;
		case 'boolean':
			pgImports.add('boolean');
			return `boolean(${colExpr})`;
		case 'bytes':
			// Drizzle doesn't support it yet...
			throw new GeneratorError("Drizzle ORM doesn't support binary data type for PostgreSQL");
		case 'datetime':
			pgImports.add('timestamp');
			return `timestamp(${[colExpr, "{ precision: 3 }"].filter(Boolean).join(', ')})`;
		case 'decimal':
			pgImports.add('decimal');
			return `decimal(${[colExpr, "{ precision: 65, scale: 30 }"].filter(Boolean).join(', ')})`;
		case 'float':
			pgImports.add('doublePrecision');
			return `doublePrecision(${colExpr})`;
		case 'json':
			pgImports.add('jsonb');
			return `jsonb(${colExpr})`;
		case 'int':
			if (defVal === 'autoincrement') {
				pgImports.add('serial');
				return `serial(${colExpr})`;
			}

			pgImports.add('integer');
			return `integer(${colExpr})`;
		case 'string':
			pgImports.add('text');
			return `text(${colExpr})`;
		default:
			return undefined;
	}
};

const addColumnModifiers = (field: DMMF.Field, column: string) => {
	if (field.isList) column = column + `.array()`;
	if (field.isRequired) column = column + `.notNull()`;
	if (field.isId) column = column + `.primaryKey()`;
	if (field.isUnique) column = column + `.unique()`;

	if (field.default) {
		const defVal = field.default;

		switch (typeof defVal) {
			case 'number':
			case 'string':
			case 'symbol':
			case 'boolean':
				column = column + `.default(${JSON.stringify(defVal)})`;
				break;
			case 'object':
				if (Array.isArray(defVal)) {
					column = column + `.default([${defVal.map((e) => JSON.stringify(e)).join(', ')}])`;
					break;
				}

				const value = defVal as {
					name: string;
					args: any[];
				};

				if (value.name === 'now') {
					column = column + `.defaultNow()`;
					break;
				}

				if (value.name === 'autoincrement') {
					break;
				}

				if (value.name === 'dbgenerated') {
					column = column + `.default(sql\`${s(value.args[0], '`')}\`)`;

					drizzleImports.add('sql');
					break;
				}

				if (/^uuid\([0-9]*\)$/.test(value.name)) {
					column = column + `.default(sql\`uuid()\`)`;

					drizzleImports.add('sql');
					break;
				}

				const stringified = `${value.name}${
					value.args.length
						? '(' + value.args.map((e) => String(e)).join(', ') + ')'
						: value.name.endsWith(')')
						? ''
						: '()'
				}`;
				const sequel = `sql\`${s(stringified, '`')}\``;

				drizzleImports.add('sql');
				column = column + `.default(${sequel})`;
				break;
		}
	}

	return column;
};

const prismaToDrizzleColumn = (
	field: DMMF.Field,
): string | undefined => {
	const colDbName = field.dbName && s(field.dbName);
	const colExpr = colDbName ? `'${colDbName}'` : '';
	let column = `\t${field.name}: `;

	if (field.kind === 'enum') {
		column = column + `${field.type}(${colExpr})`;
	} else {
		const defVal = typeof field.default === 'object' && !Array.isArray(field.default)
			? (field.default as { name: string }).name
			: undefined;

		const drizzleType = prismaToDrizzleType(field.type, colExpr, defVal);
		if (!drizzleType) return undefined;

		column = column + drizzleType;
	}

	column = addColumnModifiers(field, column);

	return column;
};

export const generatePgSchema = (options: GeneratorOptions) => {
	const { models, enums } = options.dmmf.datamodel;
	const clonedModels = JSON.parse(JSON.stringify(models)) as UnReadonlyDeep<DMMF.Model[]>;

	const manyToManyModels = extractManyToManyModels(clonedModels);

	const modelsWithImplicit = [...clonedModels, ...manyToManyModels] as DMMF.Model[];

	const pgEnums: string[] = [];

	for (const schemaEnum of enums) {
		if (!schemaEnum.values.length) continue;
		const enumDbName = s(schemaEnum.dbName ?? schemaEnum.name);

		pgImports.add('pgEnum');

		pgEnums.push(
			`export const ${schemaEnum.name} = pgEnum('${enumDbName}', [${
				schemaEnum.values.map((e) => `'${e.dbName ?? e.name}'`).join(', ')
			}])`,
		);
	}

	const tables: string[] = [];
	const rqb: string[] = [];
	const rqbv2: string[] = [];

	for (const schemaTable of modelsWithImplicit) {
		const tableDbName = s(schemaTable.dbName ?? schemaTable.name);

		const columnFields = Object.fromEntries(
			schemaTable.fields
				.map((e) => [e.name, prismaToDrizzleColumn(e)])
				.filter((e) => e[1] !== undefined),
		);

		const indexes: string[] = [];

		const relFields = schemaTable.fields.filter((field) => field.relationToFields && field.relationFromFields);
		const relations = relFields.map<string | undefined>((field) => {
			if (!field?.relationFromFields?.length) return undefined;

			const fkeyName = s(`${schemaTable.dbName ?? schemaTable.name}_${field.dbName ?? convertCase(field.name, options.generator.config['casing'] as string)}_fkey`);
			let deleteAction: string;
			switch (field.relationOnDelete) {
				case undefined:
				case 'Cascade':
					deleteAction = 'cascade';
					break;
				case 'SetNull':
					deleteAction = 'set null';
					break;
				case 'SetDefault':
					deleteAction = 'set default';
					break;
				case 'Restrict':
					deleteAction = 'restrict';
					break;
				case 'NoAction':
					deleteAction = 'no action';
					break;
				default:
					throw new GeneratorError(`Unknown delete action on relation ${fkeyName}: ${field.relationOnDelete}`);
			}

			pgImports.add('foreignKey');

			return `\tforeignKey({\n\t\tname: '${fkeyName}',\n\t\tcolumns: [${
				field.relationFromFields.map((rel) => `${schemaTable.name}.${rel}`).join(', ')
			}],\n\t\tforeignColumns: [${field.relationToFields!.map((rel) => `${field.type}.${rel}`).join(', ')}]\n\t})${
				deleteAction && deleteAction !== 'no action' ? `\n\t\t.onDelete('${deleteAction}')` : ''
			}\n\t\t.onUpdate('cascade')`;
		}).filter((e) => e !== undefined) as string[];

		indexes.push(...relations);

		if (schemaTable.uniqueIndexes.length) {
			pgImports.add('uniqueIndex');

			const uniques = schemaTable.uniqueIndexes.map((idx) => {
				const idxName = s(idx.name ?? `${schemaTable.name}_${idx.fields.join('_')}_key`);
				// _key comes from Prisma, if their AI is to be trusted

				return `\tuniqueIndex('${idxName}')\n\t\t.on(${idx.fields.map((f) => `${schemaTable.name}.${f}`).join(', ')})`;
			});

			indexes.push(...uniques);
		}

		if (schemaTable.primaryKey) {
			pgImports.add('primaryKey');

			const pk = schemaTable.primaryKey!;
			const pkName = s(pk.name ?? `${schemaTable.name}_cpk`);

			const pkField = `\tprimaryKey({\n\t\tname: '${pkName}',\n\t\tcolumns: [${
				pk.fields.map((f) => `${schemaTable.name}.${f}`).join(', ')
			}]\n\t})`;

			indexes.push(pkField);
		}

		const table = `export const ${schemaTable.name} = pgTable('${tableDbName}', {\n${
			Object.values(columnFields).join(',\n')
		}\n}${indexes.length ? `, (${schemaTable.name}) => [\n${indexes.join(',\n')}\n]` : ''});`;

		tables.push(table);

		if (!relFields.length) continue;
		if (options.generator.config['relationsVersion'] === 'v1') drizzleImports.add('relations');

		const relationArgs = new Set<string>();
		const rqbFields = relFields.map((field) => {
			relationArgs.add(field.relationFromFields?.length ? 'one' : 'many');
			const relName = s(field.relationName ?? '');

			return `\t${field.name}: ${
				field.relationFromFields?.length
					? `one(${field.type}, {\n\t\trelationName: '${relName}',\n\t\tfields: [${
						field.relationFromFields.map((e) => `${schemaTable.name}.${e}`).join(', ')
					}],\n\t\treferences: [${field.relationToFields!.map((e) => `${field.type}.${e}`).join(', ')}]\n\t})`
					: `many(${field.type}, {\n\t\trelationName: '${relName}'\n\t})`
			}`;
		}).join(',\n');

		const argString = Array.from(relationArgs.values()).join(', ');

		const rqbRelation =
			`export const ${schemaTable.name}Relations = relations(${schemaTable.name}, ({ ${argString} }) => ({\n${rqbFields}\n}));`;

		const rqbv2Fields = relFields.map(field => {
			const relName = s(field.relationName ?? '');
			return `\t\t${field.name}: ${
				field.relationFromFields?.length
				? `r.one.${field.type}({\n\t\t\tfrom: r.${schemaTable.name}.${field.relationFromFields.at(0)},\n\t\t\tto: r.${field.type}.${
				field.relationToFields?.at(0)},\n\t\t\talias: '${relName}'\n\t\t})`
				: `r.many.${field.type}({\n\t\t\talias: '${relName}'\n\t\t})`
			}`
		}).join(',\n');

		const rqbv2Relation = `\t${schemaTable.name}: {\n${ rqbv2Fields }\n\t}`

		rqbv2.push(rqbv2Relation);
		rqb.push(rqbRelation);
	}

	const drizzleImportsArr = Array.from(drizzleImports.values()).sort((a, b) => a.localeCompare(b));
	const drizzleImportsStr = drizzleImportsArr.length
		? `import { ${drizzleImportsArr.join(', ')} } from 'drizzle-orm'`
		: undefined;

	const pgImportsArr = Array.from(pgImports.values()).sort((a, b) => a.localeCompare(b));
	const pgImportsStr = pgImportsArr.length
		? `import { ${pgImportsArr.join(', ')} } from 'drizzle-orm/pg-core'`
		: undefined;

	let importsStr: string | undefined = [drizzleImportsStr, pgImportsStr].filter((e) => e !== undefined).join('\n');
	if (!importsStr.length) importsStr = undefined;

	const schemaFileName = options.schemaPath ? path.basename(options.schemaPath, path.extname(options.schemaPath)) : 'schema'

	let rqbv2Imports = [
		`import { defineRelations } from "drizzle-orm";`,
		`import * as schema from "./${schemaFileName}";`
	];

	const rqbv2Relations = `\nexport const relations = defineRelations(schema, (r) => ({\n${rqbv2.join(',\n')}\n}));` 

	const relations = [...rqbv2Imports, rqbv2Relations].join('\n')

	const schema = [importsStr, ...pgEnums, ...tables, ...(options.generator.config['relationsVersion'] === 'v1' ? rqb : [])].filter((e) => e !== undefined).join('\n\n');

	return [schema, relations] as [string, string];
};

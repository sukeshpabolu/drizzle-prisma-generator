import { toCamelCase, toSnakeCase } from 'drizzle-orm/casing';

export const convertCase = (src: string, casing?: string) =>
	casing === 'snake_case'
		? toSnakeCase(src)
		: casing === 'camelCase'
		? toCamelCase(src)
		: src;

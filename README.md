# Drizzle Prisma Generator

Automatically generate Drizzle schema from Prisma schema

## Usage

-  Install generator: `pnpm add -D drizzle-prisma-generator`
-  Add generator to prisma:  
```Prisma
generator drizzle {
  provider = "drizzle-prisma-generator"
  output = "./src/schema.ts"
  version = "v1"
}
```
:warning: - if output doesn't end with `.ts`, it will be treated like a folder, and schema will be generated to `schema.ts` inside of it.  
:warning: - binary types in `MySQL`, `PostgreSQL` are not yet supported by `drizzle-orm`, therefore will throw an error.  
:warning: - generator only supports `postgresql`, `mysql`, `sqlite` data providers, others will throw an error.  
:warning: - currently the supported value for version is v1. if version is not provided, the relations file for rabv2 is generated and saved inside the parent folder of `schema.ts` as `relations.ts`

-  Install `drizzle-orm`: `pnpm add drizzle-orm`  
-  Import schema from specified output file\folder  
-  Congratulations, now you can use Drizzle ORM with generated schemas!
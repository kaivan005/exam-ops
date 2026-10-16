import "dotenv/config";
import { definePrismaConfig } from "prisma/config";
import { defineConfig as definePostgresConfig, prisma7Schema } from "@prisma/orm-postgres/config";

export default definePrismaConfig({
  orm: definePostgresConfig({
    contract: prisma7Schema("prisma/schema.prisma"),
    output: "generated/prisma8",
    db: {
      connection: process.env.DATABASE_URL,
    },
  }),
});

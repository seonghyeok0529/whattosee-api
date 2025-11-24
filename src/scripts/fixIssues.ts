import prisma from "../lib/prisma.js";
import { IssueStatus } from "@prisma/client";

async function main() {
  const result = await prisma.issue.updateMany({
    where: {
      status: IssueStatus.DRAFT,
    },
    data: {
      status: IssueStatus.PUBLISHED,
    },
  });

  console.log("Updated:", result.count);
}

main().finally(() => prisma.$disconnect());

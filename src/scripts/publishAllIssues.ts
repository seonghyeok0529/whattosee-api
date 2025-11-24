// scripts/publishAllIssues.ts
import prisma from "../lib/prisma";
import { IssueStatus } from "@prisma/client";

async function main() {
  const result = await prisma.issue.updateMany({
    where: { status: IssueStatus.DRAFT }, // 혹은 undefined인 애만 조건 추가
    data: { status: IssueStatus.PUBLISHED },
  });
  console.log("Published:", result.count);
}

main().finally(() => prisma.$disconnect());

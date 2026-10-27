-- CreateTable
CREATE TABLE "MemberWalletMessage" (
    "memberId" TEXT NOT NULL,
    "header" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "notificationId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberWalletMessage_pkey" PRIMARY KEY ("memberId")
);

-- AddForeignKey
ALTER TABLE "MemberWalletMessage" ADD CONSTRAINT "MemberWalletMessage_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

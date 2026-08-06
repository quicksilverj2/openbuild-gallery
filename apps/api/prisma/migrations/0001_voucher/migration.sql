-- CreateTable
CREATE TABLE "Voucher" (
    "code" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "redeemedBy" TEXT,
    "redeemedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Voucher_pkey" PRIMARY KEY ("code")
);

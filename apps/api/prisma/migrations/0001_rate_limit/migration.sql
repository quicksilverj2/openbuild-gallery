-- CreateTable
CREATE TABLE "RateLimitState" (
    "key" TEXT NOT NULL,
    "tokens" DOUBLE PRECISION NOT NULL,
    "lastRefill" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitState_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Shortlink" (
    "code" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "alias" TEXT,
    "lookupKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Shortlink_pkey" PRIMARY KEY ("code")
);

-- CreateIndex
CREATE UNIQUE INDEX "Shortlink_lookupKey_key" ON "Shortlink"("lookupKey");

-- CreateIndex
CREATE INDEX "Shortlink_url_idx" ON "Shortlink"("url");

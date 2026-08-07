-- CreateTable
CREATE TABLE "Shortlink" (
    "id" TEXT NOT NULL,
    "cloneSlug" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "alias" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Shortlink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Shortlink_cloneSlug_idx" ON "Shortlink"("cloneSlug");

-- CreateIndex
CREATE UNIQUE INDEX "Shortlink_url_key" ON "Shortlink"("url");

-- CreateIndex
CREATE UNIQUE INDEX "Shortlink_code_key" ON "Shortlink"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Shortlink_alias_key" ON "Shortlink"("alias");

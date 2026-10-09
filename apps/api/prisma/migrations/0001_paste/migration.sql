-- CreateTable
CREATE TABLE "Paste" (
    "id" TEXT NOT NULL,
    "cloneSlug" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "viewsAllowed" INTEGER NOT NULL,
    "viewsRemaining" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Paste_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Paste_views_nonneg" CHECK ("viewsRemaining" >= 0 AND "viewsRemaining" <= "viewsAllowed")
);

-- CreateIndex
CREATE INDEX "Paste_cloneSlug_idx" ON "Paste"("cloneSlug");

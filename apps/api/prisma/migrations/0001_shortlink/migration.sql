-- CreateTable
CREATE TABLE \"ShortLink\" (
    \"id\" TEXT NOT NULL,
    \"code\" TEXT NOT NULL,
    \"url\" TEXT NOT NULL,
    \"alias\" TEXT,
    \"createdAt\" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT \"ShortLink_pkey\" PRIMARY KEY (\"id\")
);

-- CreateIndex
CREATE UNIQUE INDEX \"ShortLink_code_key\" ON \"ShortLink\"(\"code");

-- CreateIndex
CREATE UNIQUE INDEX \"ShortLink_url_key\" ON \"ShortLink\"(\"url\");

-- CreateIndex
CREATE UNIQUE INDEX \"ShortLink_alias_key\" ON \"ShortLink\"(\"alias\");


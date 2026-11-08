ALTER TABLE `knowledge_documents` ADD `pinned` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE VIRTUAL TABLE `knowledge_fts` USING fts5(`text`, content='knowledge_chunks', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');--> statement-breakpoint
CREATE TRIGGER `knowledge_chunks_ai` AFTER INSERT ON `knowledge_chunks` BEGIN
  INSERT INTO `knowledge_fts`(rowid, `text`) VALUES (new.rowid, new.`text`);
END;--> statement-breakpoint
CREATE TRIGGER `knowledge_chunks_ad` AFTER DELETE ON `knowledge_chunks` BEGIN
  INSERT INTO `knowledge_fts`(`knowledge_fts`, rowid, `text`) VALUES ('delete', old.rowid, old.`text`);
END;--> statement-breakpoint
INSERT INTO `knowledge_fts`(`knowledge_fts`) VALUES ('rebuild');

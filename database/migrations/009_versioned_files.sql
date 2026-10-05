-- 009: edit / lock policy, phase 5 — fuel receipts and contract documents are versioned: a new upload never
-- replaces the old file, every version stays downloadable, and replacing one needs a reason.
CREATE TABLE IF NOT EXISTS eq_file_versions (
  file_version_id  INT NOT NULL AUTO_INCREMENT,
  owner_table      ENUM('eq_fuel_issues','eq_vendor_contracts') NOT NULL,
  owner_id         INT NOT NULL,
  version_no       INT NOT NULL,
  storage_key      VARCHAR(500) NOT NULL,
  sha256           CHAR(64) NULL,
  content_type     VARCHAR(100) NULL,
  size_bytes       INT NULL,
  original_name    VARCHAR(255) NULL,
  reason           VARCHAR(500) NULL COMMENT 'Why a previous version was replaced',
  uploaded_by_user_id INT NULL,
  uploaded_at      DATETIME NOT NULL,
  PRIMARY KEY (file_version_id),
  UNIQUE KEY uq_eqfv_owner_version (owner_table, owner_id, version_no),
  CONSTRAINT fk_eqfv_user FOREIGN KEY (uploaded_by_user_id) REFERENCES users (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- files uploaded before versioning become version 1
INSERT INTO eq_file_versions (owner_table, owner_id, version_no, storage_key, uploaded_at)
  SELECT 'eq_fuel_issues', fuel_issue_id, 1, receipt_path, COALESCE(created_at, NOW()) FROM eq_fuel_issues WHERE receipt_path IS NOT NULL;
INSERT INTO eq_file_versions (owner_table, owner_id, version_no, storage_key, sha256, uploaded_at)
  SELECT 'eq_vendor_contracts', vendor_contract_id, 1, document_path, document_sha256, COALESCE(created_at, NOW()) FROM eq_vendor_contracts WHERE document_path IS NOT NULL;

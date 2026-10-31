const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.join(__dirname, 'data.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  // Settings / Admin Profile
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      entity_name TEXT NOT NULL DEFAULT 'منصة التعاميم الرسمية',
      admin_username TEXT NOT NULL DEFAULT 'admin',
      admin_password_hash TEXT NOT NULL
    )
  `);

  // Insert default admin if not exists (username: admin, password: adminpassword)
  db.get('SELECT COUNT(*) as count FROM settings', (err, row) => {
    if (row && row.count === 0) {
      const defaultHash = bcrypt.hashSync('admin123', 10);
      db.run(
        `INSERT INTO settings (id, entity_name, admin_username, admin_password_hash) VALUES (1, 'الجهة الرسمية', 'admin', ?)`,
        [defaultHash]
      );
    }
  });

  // Circulars (التعاميم)
  db.run(`
    CREATE TABLE IF NOT EXISTS circulars (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      file_path TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Employees (الموظفات)
  db.run(`
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      job_title TEXT,
      department TEXT,
      mobile TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Circular Recipients & Signatures (استلام وتوقيع التعاميم)
  db.run(`
    CREATE TABLE IF NOT EXISTS circular_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      circular_id INTEGER NOT NULL,
      employee_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      status TEXT DEFAULT 'pending', -- 'pending', 'viewed', 'signed'
      signature_data TEXT,
      viewed_at DATETIME,
      signed_at DATETIME,
      ip_address TEXT,
      user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (circular_id) REFERENCES circulars (id) ON DELETE CASCADE,
      FOREIGN KEY (employee_id) REFERENCES employees (id) ON DELETE CASCADE
    )
  `);
});

module.exports = db;

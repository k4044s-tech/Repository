const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads', 'circulars');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer Storage Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname) || '.pdf';
    cb(null, 'circular-' + uniqueSuffix + ext);
  }
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('الملف يجب أن يكون بصيغة PDF فقط'));
    }
  }
});

// Middlewares
app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- Helper Database Wrappers ---
function dbQueryAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function dbQueryGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

// ================= ADMIN AUTH & SETTINGS =================

// Admin Login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const admin = await dbQueryGet('SELECT * FROM settings WHERE id = 1');
    if (!admin) return res.status(400).json({ error: 'بيانات غير صحيحة' });

    if (username !== admin.admin_username) {
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    const match = await bcrypt.compare(password, admin.admin_password_hash);
    if (!match) {
      return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
    }

    res.json({ success: true, entityName: admin.entity_name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Settings
app.get('/api/admin/settings', async (req, res) => {
  try {
    const settings = await dbQueryGet('SELECT entity_name, admin_username FROM settings WHERE id = 1');
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update Settings
app.post('/api/admin/settings', async (req, res) => {
  try {
    const { entity_name, new_password } = req.body;
    if (new_password && new_password.trim() !== '') {
      const hash = await bcrypt.hash(new_password, 10);
      await dbRun('UPDATE settings SET entity_name = ?, admin_password_hash = ? WHERE id = 1', [entity_name, hash]);
    } else {
      await dbRun('UPDATE settings SET entity_name = ? WHERE id = 1', [entity_name]);
    }
    res.json({ success: true, message: 'تم حفظ الإعدادات بنجاح' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dashboard Stats
app.get('/api/admin/dashboard-stats', async (req, res) => {
  try {
    const totalCirculars = (await dbQueryGet('SELECT COUNT(*) as count FROM circulars')).count;
    const totalEmployees = (await dbQueryGet('SELECT COUNT(*) as count FROM employees')).count;
    const totalRecipients = (await dbQueryGet('SELECT COUNT(*) as count FROM circular_recipients')).count;
    const totalSigned = (await dbQueryGet("SELECT COUNT(*) as count FROM circular_recipients WHERE status = 'signed'")).count;
    const totalPending = totalRecipients - totalSigned;

    res.json({
      totalCirculars,
      totalEmployees,
      totalRecipients,
      totalSigned,
      totalPending
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= EMPLOYEE MANAGEMENT =================

// List Employees
app.get('/api/employees', async (req, res) => {
  try {
    const employees = await dbQueryAll('SELECT * FROM employees ORDER BY id DESC');
    res.json(employees);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add Employee
app.post('/api/employees', async (req, res) => {
  try {
    const { name, job_title, department, mobile } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'اسم الموظفة مطلوب' });

    const result = await dbRun(
      'INSERT INTO employees (name, job_title, department, mobile) VALUES (?, ?, ?, ?)',
      [name.trim(), job_title || '', department || '', mobile || '']
    );
    res.json({ success: true, id: result.lastID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete Employee
app.delete('/api/employees/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM circular_recipients WHERE employee_id = ?', [req.params.id]);
    await dbRun('DELETE FROM employees WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= CIRCULARS MANAGEMENT =================

// List Circulars
app.get('/api/circulars', async (req, res) => {
  try {
    const circulars = await dbQueryAll(`
      SELECT c.*,
        COUNT(cr.id) as total_recipients,
        SUM(CASE WHEN cr.status = 'signed' THEN 1 ELSE 0 END) as signed_count,
        SUM(CASE WHEN cr.status = 'pending' THEN 1 ELSE 0 END) as pending_count
      FROM circulars c
      LEFT JOIN circular_recipients cr ON c.id = cr.circular_id
      GROUP BY c.id
      ORDER BY c.id DESC
    `);
    res.json(circulars);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create Circular
app.post('/api/circulars', upload.single('file'), async (req, res) => {
  try {
    const { title, description, employee_ids } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'عنوان التعميم مطلوب' });
    if (!req.file) return res.status(400).json({ error: 'يرجى رفع ملف التعميم PDF' });

    const file_path = '/uploads/circulars/' + req.file.filename;
    const result = await dbRun(
      'INSERT INTO circulars (title, description, file_path, original_filename) VALUES (?, ?, ?, ?)',
      [title.trim(), description || '', file_path, req.file.originalname]
    );

    const circularId = result.lastID;

    // Determine target employees
    let selectedEmpIds = [];
    if (employee_ids === 'all') {
      const emps = await dbQueryAll('SELECT id FROM employees');
      selectedEmpIds = emps.map(e => e.id);
    } else if (typeof employee_ids === 'string') {
      selectedEmpIds = JSON.parse(employee_ids || '[]');
    } else if (Array.isArray(employee_ids)) {
      selectedEmpIds = employee_ids;
    }

    for (const empId of selectedEmpIds) {
      const token = uuidv4();
      await dbRun(
        'INSERT INTO circular_recipients (circular_id, employee_id, token) VALUES (?, ?, ?)',
        [circularId, empId, token]
      );
    }

    res.json({ success: true, circularId, recipientCount: selectedEmpIds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Single Circular Details with Recipients List
app.get('/api/circulars/:id', async (req, res) => {
  try {
    const circular = await dbQueryGet('SELECT * FROM circulars WHERE id = ?', [req.params.id]);
    if (!circular) return res.status(404).json({ error: 'التعميم غير موجود' });

    const recipients = await dbQueryAll(`
      SELECT cr.*, e.name as employee_name, e.job_title, e.department, e.mobile
      FROM circular_recipients cr
      JOIN employees e ON cr.employee_id = e.id
      WHERE cr.circular_id = ?
      ORDER BY cr.id ASC
    `, [req.params.id]);

    res.json({ circular, recipients });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Assign More Employees to Circular
app.post('/api/circulars/:id/recipients', async (req, res) => {
  try {
    const circularId = req.params.id;
    const { employee_ids } = req.body;
    let selectedEmpIds = Array.isArray(employee_ids) ? employee_ids : JSON.parse(employee_ids || '[]');

    let addedCount = 0;
    for (const empId of selectedEmpIds) {
      const existing = await dbQueryGet(
        'SELECT id FROM circular_recipients WHERE circular_id = ? AND employee_id = ?',
        [circularId, empId]
      );
      if (!existing) {
        const token = uuidv4();
        await dbRun(
          'INSERT INTO circular_recipients (circular_id, employee_id, token) VALUES (?, ?, ?)',
          [circularId, empId, token]
        );
        addedCount++;
      }
    }

    res.json({ success: true, addedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete Circular
app.delete('/api/circulars/:id', async (req, res) => {
  try {
    const circular = await dbQueryGet('SELECT * FROM circulars WHERE id = ?', [req.params.id]);
    if (circular && circular.file_path) {
      const fullPath = path.join(__dirname, circular.file_path);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    }
    await dbRun('DELETE FROM circular_recipients WHERE circular_id = ?', [req.params.id]);
    await dbRun('DELETE FROM circulars WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= PUBLIC SIGNING ROUTES =================

// Get Circular Info by Unique Employee Token
app.get('/api/public/sign-info/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const recipient = await dbQueryGet(`
      SELECT cr.*, e.name as employee_name, e.job_title, e.department,
        c.title as circular_title, c.description as circular_description, c.file_path, c.created_at as circular_date
      FROM circular_recipients cr
      JOIN employees e ON cr.employee_id = e.id
      JOIN circulars c ON cr.circular_id = c.id
      WHERE cr.token = ?
    `, [token]);

    if (!recipient) {
      return res.status(404).json({ error: 'الرابط غير صحيح أو انتهت صلاحيته' });
    }

    const settings = await dbQueryGet('SELECT entity_name FROM settings WHERE id = 1');

    // Update status to 'viewed' if currently 'pending'
    if (recipient.status === 'pending') {
      await dbRun("UPDATE circular_recipients SET status = 'viewed', viewed_at = CURRENT_TIMESTAMP WHERE id = ?", [recipient.id]);
    }

    res.json({
      recipientId: recipient.id,
      employeeName: recipient.employee_name,
      jobTitle: recipient.job_title,
      department: recipient.department,
      circularTitle: recipient.circular_title,
      circularDescription: recipient.circular_description,
      circularFilePath: recipient.file_path,
      circularDate: recipient.circular_date,
      status: recipient.status,
      signedAt: recipient.signed_at,
      signatureData: recipient.signature_data,
      entityName: settings ? settings.entity_name : 'الجهة الرسمية'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Submit Signature
app.post('/api/public/sign/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const { signatureData } = req.body;

    if (!signatureData || !signatureData.startsWith('data:image/png')) {
      return res.status(400).json({ error: 'يرجى تقديم التوقيع الإلكتروني بشكل صحيح' });
    }

    const recipient = await dbQueryGet('SELECT * FROM circular_recipients WHERE token = ?', [token]);
    if (!recipient) {
      return res.status(404).json({ error: 'الرابط غير صحيح' });
    }

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const userAgent = req.headers['user-agent'] || '';

    await dbRun(`
      UPDATE circular_recipients
      SET status = 'signed', signature_data = ?, signed_at = CURRENT_TIMESTAMP, ip_address = ?, user_agent = ?
      WHERE token = ?
    `, [signatureData, ip, userAgent, token]);

    res.json({ success: true, message: 'تم التوقيع والاعتماد بنجاح' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ================= PDF EXPORT WITH SIGNATURE AUDIT SHEET =================

app.get('/api/circulars/:id/export-pdf', async (req, res) => {
  try {
    const circular = await dbQueryGet('SELECT * FROM circulars WHERE id = ?', [req.params.id]);
    if (!circular) return res.status(404).send('التعميم غير موجود');

    const recipients = await dbQueryAll(`
      SELECT cr.*, e.name as employee_name, e.job_title, e.department, e.mobile
      FROM circular_recipients cr
      JOIN employees e ON cr.employee_id = e.id
      WHERE cr.circular_id = ?
      ORDER BY cr.id ASC
    `, [req.params.id]);

    const settings = await dbQueryGet('SELECT entity_name FROM settings WHERE id = 1');
    const entityName = settings ? settings.entity_name : 'الجهة الرسمية';

    const originalPdfPath = path.join(__dirname, circular.file_path);
    if (!fs.existsSync(originalPdfPath)) {
      return res.status(404).send('ملف PDF الأصلي غير موجود على السيرفر');
    }

    const originalPdfBuffer = fs.readFileSync(originalPdfPath);
    const pdfDoc = await PDFDocument.load(originalPdfBuffer);

    // Create a new signature report page
    const page = pdfDoc.addPage([595.28, 841.89]); // A4 Size
    const { width, height } = page.getSize();

    // Standard Font for basic stats & titles
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // Header section
    page.drawRectangle({
      x: 0,
      y: height - 80,
      width: width,
      height: 80,
      color: rgb(0.08, 0.28, 0.52)
    });

    page.drawText('Circular Signature Audit Record', {
      x: 35,
      y: height - 45,
      size: 20,
      font: boldFont,
      color: rgb(1, 1, 1)
    });

    page.drawText(`Entity: ${entityName} | Document ID: #${circular.id}`, {
      x: 35,
      y: height - 65,
      size: 10,
      font: font,
      color: rgb(0.85, 0.92, 1)
    });

    // Subtitle & Metadata
    page.drawText(`Title: ${circular.title}`, {
      x: 35,
      y: height - 110,
      size: 13,
      font: boldFont,
      color: rgb(0.1, 0.1, 0.1)
    });

    const totalCount = recipients.length;
    const signedCount = recipients.filter(r => r.status === 'signed').length;
    const summaryText = `Total Recipients: ${totalCount}  |  Signed: ${signedCount}  |  Pending: ${totalCount - signedCount}`;
    page.drawText(summaryText, {
      x: 35,
      y: height - 130,
      size: 10,
      font: font,
      color: rgb(0.3, 0.3, 0.3)
    });

    // Table Header
    let startY = height - 160;
    page.drawRectangle({
      x: 30,
      y: startY - 20,
      width: width - 60,
      height: 25,
      color: rgb(0.92, 0.94, 0.97)
    });

    page.drawText('#', { x: 40, y: startY - 14, size: 9, font: boldFont });
    page.drawText('Employee Name', { x: 70, y: startY - 14, size: 9, font: boldFont });
    page.drawText('Department / Title', { x: 220, y: startY - 14, size: 9, font: boldFont });
    page.drawText('Status & Time', { x: 360, y: startY - 14, size: 9, font: boldFont });
    page.drawText('Signature Image', { x: 480, y: startY - 14, size: 9, font: boldFont });

    // Table Rows
    let currentY = startY - 25;
    const rowHeight = 45;

    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];

      // Page overflow check
      if (currentY < 60) {
        const newPage = pdfDoc.addPage([595.28, 841.89]);
        currentY = height - 60;
      }

      page.drawRectangle({
        x: 30,
        y: currentY - rowHeight + 10,
        width: width - 60,
        height: rowHeight,
        color: i % 2 === 0 ? rgb(0.98, 0.98, 0.99) : rgb(1, 1, 1),
        borderColor: rgb(0.88, 0.88, 0.88),
        borderWidth: 0.5
      });

      page.drawText(`${i + 1}`, { x: 40, y: currentY - 15, size: 9, font: font });
      page.drawText(`${r.employee_name || 'N/A'}`, { x: 70, y: currentY - 15, size: 9, font: boldFont });
      page.drawText(`${r.department || ''} - ${r.job_title || ''}`, { x: 220, y: currentY - 15, size: 8, font: font });

      if (r.status === 'signed') {
        page.drawText(`SIGNED`, { x: 360, y: currentY - 12, size: 8, font: boldFont, color: rgb(0.1, 0.6, 0.2) });
        page.drawText(`${r.signed_at || ''}`, { x: 360, y: currentY - 24, size: 7, font: font, color: rgb(0.4, 0.4, 0.4) });

        // Embed signature image if available
        if (r.signature_data && r.signature_data.startsWith('data:image/png;base64,')) {
          try {
            const base64Png = r.signature_data.replace('data:image/png;base64,', '');
            const pngImageBytes = Buffer.from(base64Png, 'base64');
            const pngImage = await pdfDoc.embedPng(pngImageBytes);
            page.drawImage(pngImage, {
              x: 480,
              y: currentY - rowHeight + 14,
              width: 70,
              height: 30
            });
          } catch (imgErr) {
            page.drawText('Signature Error', { x: 480, y: currentY - 20, size: 8, font: font, color: rgb(0.8, 0.2, 0.2) });
          }
        }
      } else {
        page.drawText(`PENDING`, { x: 360, y: currentY - 20, size: 9, font: boldFont, color: rgb(0.8, 0.4, 0) });
        page.drawText('---', { x: 480, y: currentY - 20, size: 9, font: font });
      }

      currentY -= rowHeight;
    }

    // Footer
    page.drawText(`Generated automatically by Circulars & Signatures Platform - ${new Date().toLocaleString()}`, {
      x: 35,
      y: 20,
      size: 8,
      font: font,
      color: rgb(0.5, 0.5, 0.5)
    });

    const pdfBytes = await pdfDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Circular_${circular.id}_Signed.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error('PDF Export Error:', err);
    res.status(500).send('خطأ أثناء إنشاء ملف PDF: ' + err.message);
  }
});

// App fallback routes
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/sign/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sign.html'));
});

app.get('/', (req, res) => {
  res.redirect('/admin');
});

// Start Server
app.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`🚀 Platform is live on: http://localhost:${PORT}`);
  console.log(`📌 Admin Panel:       http://localhost:${PORT}/admin`);
  console.log(`===================================================`);
});

const db = require('../db');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

exports.exportPDF = async (req, res) => {
  const userId = req.user.id;
  const username = req.user.username;

  try {
    // 1. Fetch attendance data
    const attendanceRes = await db.query(
      'SELECT date::text, status, study_hours, daily_notes, ai_summary FROM clover_attendance WHERE user_id = $1 ORDER BY date DESC LIMIT 30',
      [userId]
    );
    const logs = attendanceRes.rows;

    // 2. Fetch session data
    const sessionRes = await db.query(
      'SELECT type, mode, duration_seconds, completed_at FROM clover_focus_sessions WHERE user_id = $1 ORDER BY completed_at DESC LIMIT 15',
      [userId]
    );
    const sessions = sessionRes.rows;

    // Compute metrics
    const totalPresent = logs.filter(log => log.status === 'Present').length;
    const totalStudyHours = logs.reduce((acc, log) => acc + Number(log.study_hours), 0).toFixed(2);
    const attendancePercentage = logs.length > 0 ? Math.round((totalPresent / logs.length) * 100) : 0;

    // Create PDF
    const doc = new PDFDocument({ margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="code_clover_${username}_report.pdf"`);
    doc.pipe(res);

    // Header styling - Emerald/Leaf green accent
    doc.rect(0, 0, 612, 100).fill('#2E7D32');
    doc.fillColor('#FFFFFF').fontSize(24).text('Code Clover 🍀 Study Report', 50, 25, { bold: true });
    doc.fontSize(10).text(`Generated for ${username} on ${new Date().toLocaleDateString()}`, 50, 60);

    // Dashboard Statistics Summary Card
    doc.fillColor('#333333').fontSize(14).text('Progress Dashboard Metrics', 50, 120, { underline: true });
    doc.rect(50, 140, 512, 60).fill('#F1F8E9');
    
    doc.fillColor('#2E7D32').fontSize(10)
       .text('Attendance Rate', 70, 150)
       .text('Total Focused Time', 240, 150)
       .text('Logs Counted', 410, 150);

    doc.fillColor('#1B5E20').fontSize(18)
       .text(`${attendancePercentage}%`, 70, 168)
       .text(`${totalStudyHours} hrs`, 240, 168)
       .text(`${logs.length} days`, 410, 168);

    // Attendance Table Header
    doc.fillColor('#333333').fontSize(14).text('Recent Attendance Log (Past 30 entries)', 50, 220, { underline: true });

    let yPosition = 250;
    doc.fontSize(10).fillColor('#1B5E20')
       .text('Date', 50, yPosition, { bold: true })
       .text('Status', 150, yPosition, { bold: true })
       .text('Study Hours', 250, yPosition, { bold: true })
       .text('Daily Notes', 350, yPosition, { bold: true });

    doc.moveTo(50, yPosition + 15).lineTo(562, yPosition + 15).strokeColor('#4CAF50').stroke();
    yPosition += 20;

    // Populate log entries
    doc.fillColor('#333333');
    logs.forEach((log) => {
      if (yPosition > 680) { // Add new page if overflow
        doc.addPage();
        yPosition = 50;
        doc.fontSize(10).fillColor('#1B5E20')
           .text('Date', 50, yPosition, { bold: true })
           .text('Status', 150, yPosition, { bold: true })
           .text('Study Hours', 250, yPosition, { bold: true })
           .text('Daily Notes', 350, yPosition, { bold: true });
        doc.moveTo(50, yPosition + 15).lineTo(562, yPosition + 15).strokeColor('#4CAF50').stroke();
        yPosition += 25;
        doc.fillColor('#333333');
      }

      // Truncate notes if too long
      const notes = log.daily_notes 
        ? (log.daily_notes.length > 35 ? log.daily_notes.substring(0, 32) + '...' : log.daily_notes)
        : 'N/A';

      doc.text(log.date, 50, yPosition);
      doc.text(log.status, 150, yPosition);
      doc.text(`${log.study_hours} hrs`, 250, yPosition);
      doc.text(notes, 350, yPosition);

      yPosition += 20;
    });

    // Recent Focus Sessions List
    if (sessions.length > 0) {
      if (yPosition > 580) {
        doc.addPage();
        yPosition = 50;
      } else {
        yPosition += 20;
      }

      doc.fillColor('#333333').fontSize(14).text('Recent Focus Sessions Logs', 50, yPosition, { underline: true });
      yPosition += 25;

      doc.fontSize(10).fillColor('#1B5E20')
         .text('Finished Date', 50, yPosition, { bold: true })
         .text('Timer Type', 180, yPosition, { bold: true })
         .text('Mode Details', 300, yPosition, { bold: true })
         .text('Focus Duration', 430, yPosition, { bold: true });
      doc.moveTo(50, yPosition + 15).lineTo(562, yPosition + 15).strokeColor('#4CAF50').stroke();
      yPosition += 20;

      doc.fillColor('#333333');
      sessions.forEach(sess => {
        if (yPosition > 700) {
          doc.addPage();
          yPosition = 50;
        }

        const dateStr = new Date(sess.completed_at).toLocaleDateString();
        const durationStr = `${Math.round(sess.duration_seconds / 60)} mins`;

        doc.text(dateStr, 50, yPosition);
        doc.text(sess.type, 180, yPosition);
        doc.text(sess.mode, 300, yPosition);
        doc.text(durationStr, 430, yPosition);

        yPosition += 20;
      });
    }

    doc.end();

  } catch (err) {
    console.error('PDF Generation Error:', err.message);
    res.status(500).json({ message: 'Server error generating PDF report' });
  }
};

exports.exportExcel = async (req, res) => {
  const userId = req.user.id;
  const username = req.user.username;

  try {
    // Fetch logs
    const result = await db.query(
      'SELECT date::text, status, study_hours, daily_notes, ai_summary FROM clover_attendance WHERE user_id = $1 ORDER BY date DESC',
      [userId]
    );
    const logs = result.rows;

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Clover Attendance Logs');

    // Define columns
    worksheet.columns = [
      { header: 'Study Date', key: 'date', width: 15 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Study Hours', key: 'study_hours', width: 15 },
      { header: 'Daily Notes', key: 'daily_notes', width: 45 },
      { header: 'AI Daily Summary', key: 'ai_summary', width: 45 }
    ];

    // Format header row (Green theme)
    const headerRow = worksheet.getRow(1);
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: '2E7D32' } // Leaf Green
      };
      cell.font = {
        name: 'Arial',
        size: 11,
        bold: true,
        color: { argb: 'FFFFFF' }
      };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
    headerRow.height = 25;

    // Add rows
    logs.forEach((log) => {
      worksheet.addRow({
        date: log.date,
        status: log.status,
        study_hours: Number(log.study_hours),
        daily_notes: log.daily_notes || '',
        ai_summary: log.ai_summary || ''
      });
    });

    // Style data alignment
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) {
        row.getCell(1).alignment = { horizontal: 'center' };
        row.getCell(2).alignment = { horizontal: 'center' };
        row.getCell(3).alignment = { horizontal: 'right' };
        
        // Striped rows (alternate colors)
        if (rowNumber % 2 === 0) {
          row.eachCell((cell) => {
            cell.fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'F1F8E9' } // Light Green Accent tint
            };
          });
        }
      }
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="code_clover_${username}_attendance.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error('Excel Generation Error:', err.message);
    res.status(500).json({ message: 'Server error generating Excel file' });
  }
};

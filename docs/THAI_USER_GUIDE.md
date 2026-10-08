# คู่มือผู้ใช้ภาษาไทย

## ระบบนี้ทำอะไร

Remote-MCP-Server เป็นชั้นเครื่องมือกลาง ไม่ผูกกับโปรเจกต์ใดโปรเจกต์หนึ่ง AI สามารถจัดการไฟล์ ค้นหา รัน terminal/process ทำงานยาวแบบ job ใช้ Git ดาวน์โหลด/แตกไฟล์ แปลงสื่อ อ่านและแก้เอกสาร ควบคุม browser/GUI และตรวจสุขภาพระบบตามสิทธิ์ของบัญชี Windows

ข้อมูลเฉพาะงาน เช่น Project Overview, research, workflow, ประวัติการผลิต และ `WORK_CHECKPOINT.md` ต้องอยู่ในโฟลเดอร์โปรเจกต์นั้น ระบบ MCP เก็บเพียงสถานะการทำงาน เช่น grant, session, job ID, schedule, watch, audit และ path reference เท่านั้น จึงใช้ server เดิมกับงานวิดีโอ เขียนโปรแกรม จัดไฟล์ หรือ automation ได้โดยไม่ปนความจำกัน

## การอนุญาตแบบครั้งเดียว

เมื่อ client ใหม่เชื่อมต่อ คุณตรวจชื่อ client/principal แล้วกด Full Access หนึ่งครั้ง Grant ผูกกับ client และเครื่องนี้ ไม่มีวันหมดอายุสั้นโดยอัตโนมัติ และครอบคลุมคำสั่งที่ policy อนุญาตโดยไม่ถามซ้ำ หาก revoke/disconnect, unlink device, security reset หรือ Emergency Stop การทำงานใหม่และขั้นตอนถัดไปของ job จะถูกปฏิเสธทันที

หน้า owner console ใช้ดู trusted clients, ตัดการเชื่อมต่อ และ revoke ได้ อย่าส่ง owner token ให้ใครหรือใส่ลงในแชท เก็บ URL สำหรับ remote access หลัง HTTPS reverse proxy เท่านั้น ห้ามเปิด HTTP ตรงสู่อินเทอร์เน็ต

## งานยาวและการกลับมาทำต่อ

งานแบบ durable job เก็บขั้นตอน log heartbeat และหลักฐานตรวจผลไว้ใน SQLite จึงทำงานต่อได้แม้ปิดหน้าเว็บหรือแชทไม่อยู่ เมื่อ server กลับมาจะตรวจสถานะเดิมและทำต่อจากขั้นที่ยืนยันแล้ว ทุกขั้นตรวจ grant ใหม่ กระบวนการ interactive terminal ที่ขาดการเชื่อมต่อกับ process จริงจะรายงาน `orphaned` แทนการแกล้งบอกว่ายังรันอยู่

## ดูแลระบบ

- เปิดหรือกู้ระบบที่ติดตั้งแล้ว: `Set-Location E:\Remote-MCP-Server` แล้ว `.\เปิดใช้งานระบบ.ps1`
- ตรวจสถานะ: `.\scripts\service\status.ps1`
- ตรวจระบบก่อนปล่อยงาน: `.\scripts\release\verify.ps1`
- สำรอง: `.\scripts\operations\backup.ps1 -DataRoot "$env:ProgramData\Remote-MCP-Server" -DestinationRoot "D:\Remote-MCP-Backups"`
- กู้คืน: ใช้ `restore.ps1` กับ backup ที่ manifest/hash ผ่านเท่านั้น
- หยุดฉุกเฉิน: `emergency-stop.ps1 -Force`
- ล้างสิทธิ์ทั้งหมดเมื่อสงสัยการรั่วไหล: `security-reset.ps1`
- ถอน service: `.\scripts\service\uninstall.ps1`

## ข้อจำกัดที่ตั้งใจไว้

การติดตั้ง service/broker ครั้งแรกต้องใช้ Administrator; UAC Secure Desktop, CAPTCHA, MFA และ consent ของเว็บไซต์ต้องให้มนุษย์ทำ Browser/GUI ต้องมี desktop ที่ interactive และ Edge/Chrome ที่รองรับ งานเอกสาร/สื่อบางชนิดต้องมี Python package หรือ FFmpeg หากไม่มี health จะรายงาน unavailable อย่างตรงไปตรงมา ไม่ควรถือว่าเป็นบัคของ Full Access

เมื่อเกิดปัญหา อย่าลบฐานข้อมูลหรือโฟลเดอร์ ProgramData ทันที ให้ Emergency Stop สำรองข้อมูล เก็บ error code/เวลา/job ID แบบไม่เปิดเผย secret แล้วทำตาม `TROUBLESHOOTING.md`

# เริ่มใช้งานแบบเร็ว (Windows)

คู่มือฉบับเต็มสำหรับติดตั้งครั้งแรก สร้าง Tunnel เชื่อม ChatGPT และให้ Full Access อยู่ที่ [คู่มือการติดตั้งครั้งแรกและเชื่อมต่อแชตจีพีที](../%E0%B8%84%E0%B8%B9%E0%B9%88%E0%B8%A1%E0%B8%B7%E0%B8%AD%E0%B8%81%E0%B8%B2%E0%B8%A3%E0%B8%95%E0%B8%B4%E0%B8%94%E0%B8%95%E0%B8%B1%E0%B9%89%E0%B8%87%E0%B8%84%E0%B8%A3%E0%B8%B1%E0%B9%89%E0%B8%87%E0%B9%81%E0%B8%A3%E0%B8%81%E0%B9%81%E0%B8%A5%E0%B8%B0%E0%B9%80%E0%B8%8A%E0%B8%B7%E0%B9%88%E0%B8%AD%E0%B8%A1%E0%B8%95%E0%B9%88%E0%B8%AD%E0%B9%81%E0%B8%8A%E0%B8%95%E0%B8%88%E0%B8%B5%E0%B8%9E%E0%B8%B5%E0%B8%97%E0%B8%B5.md) โปรดอ่านฉบับเต็มก่อนนำ URL ในเครื่องไปกรอกในหน้า ChatGPT

ระบบนี้ทำให้ ChatGPT/MCP client ที่ยืนยันตัวตนแล้วเข้ามาทำงานบนเครื่องได้แบบต่อเนื่อง โดยอนุญาต Full Access ครั้งเดียวและใช้สิทธิ์เดิมจนกว่าคุณจะ revoke ไม่ต้องกดอนุมัติซ้ำทุกคำสั่ง

ต้องมี Windows 10/11, Git, Node.js 24.15 ขึ้นไปแต่ต่ำกว่า 25 และ npm จากนั้นเปิด PowerShell:

```powershell
git clone https://github.com/chokza007/Remote-MCP-Server.git E:\Remote-MCP-Server
Set-Location E:\Remote-MCP-Server
npm ci
npm run build
npm test
```

เปิด PowerShell แบบ Run as administrator หนึ่งครั้งเพื่อติดตั้งให้เริ่มอัตโนมัติและทำงานยาวโดยไม่จำกัดเวลา:

```powershell
Set-Location E:\Remote-MCP-Server
.\scripts\service\install.ps1
```

จุดเชื่อมต่อในเครื่องคือ `http://127.0.0.1:7331/mcp` แต่ ChatGPT บนเว็บต้องเชื่อมผ่าน **Secure MCP Tunnel** ห้ามนำ URL นี้ไปใส่ในช่อง URL ของเซิร์ฟเวอร์โดยตรง หลังเชื่อมสำเร็จให้ผูก Full Access 100% กับตัวตนของ ChatGPT หนึ่งครั้งตามคู่มือฉบับเต็ม จากนั้นระบบไม่ถามรายคำสั่ง และแชทใหม่ รีเฟรช เชื่อมต่อใหม่ รีสตาร์ต server หรือรีบูต Windows ยังใช้สิทธิ์เดิมได้

หากต้องหยุดฉุกเฉิน ให้เปิด PowerShell แบบ Administrator:

```powershell
.\scripts\operations\emergency-stop.ps1 -Force
```

Full Access ไม่สามารถข้าม CAPTCHA, MFA, Secure Desktop/UAC ตอนติดตั้งครั้งแรก หรือสิทธิ์ที่ Windows account ไม่มีได้ และการทำงานสำคัญยังมี audit log เสมอ อ่านรายละเอียดต่อที่ `THAI_USER_GUIDE.md` และ `TROUBLESHOOTING.md`

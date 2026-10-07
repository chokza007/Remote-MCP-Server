# เริ่มใช้งานแบบเร็ว (Windows)

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

จุดเชื่อมต่อในเครื่องคือ `http://127.0.0.1:7331/mcp` ครั้งแรกให้เลือก **Grant Full Access to This Computer** หน้าอนุญาตเป็นธีมมืด หลังจากนั้นแชทใหม่ รีเฟรช เชื่อมต่อใหม่ รีสตาร์ต server หรือรีบูต Windows ยังใช้สิทธิ์เดิมได้

หากต้องหยุดฉุกเฉิน ให้เปิด PowerShell แบบ Administrator:

```powershell
.\scripts\operations\emergency-stop.ps1 -Force
```

Full Access ไม่สามารถข้าม CAPTCHA, MFA, Secure Desktop/UAC ตอนติดตั้งครั้งแรก หรือสิทธิ์ที่ Windows account ไม่มีได้ และการทำงานสำคัญยังมี audit log เสมอ อ่านรายละเอียดต่อที่ `THAI_USER_GUIDE.md` และ `TROUBLESHOOTING.md`

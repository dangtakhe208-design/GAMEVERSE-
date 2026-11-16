# GAMEVERSE — Backend starter (Giai đoạn 1)

Bản này nối giao diện GAMEVERSE với backend Node.js/Express và SQLite.

## Đã hoạt động
- Đăng ký tài khoản, kiểm tra email trùng.
- Mật khẩu được băm bằng bcrypt (không lưu mật khẩu dạng chữ thường).
- Đăng nhập/đăng xuất bằng JWT lưu trong cookie HttpOnly.
- Cơ sở dữ liệu SQLite lưu tài khoản và game.
- Đăng thông tin game (tên, mô tả, thể loại) và tải danh sách game từ máy chủ.
- Giới hạn số lần gọi API đăng nhập/đăng ký.

## Cài đặt trên Windows 10/11

1. Cài Node.js bản LTS từ https://nodejs.org/ (nếu máy chưa có).
2. Giải nén thư mục `GAMEVERSE-backend`.
3. Mở thư mục đó bằng VS Code: File → Open Folder.
4. Mở Terminal → New Terminal.
5. Chạy `npm install` và đợi cài xong.
6. Tạo file `.env` ở cùng cấp với `server.js`. Sao chép nội dung từ `.env.example` sang `.env`.
7. Thay `JWT_SECRET` bằng chuỗi bí mật ngẫu nhiên dài ít nhất 32 ký tự. Không gửi file `.env` cho người khác và không đưa lên GitHub.
8. Chạy `npm start`.
9. Mở Chrome và truy cập `http://localhost:3000`.
10. Tạo tài khoản, đăng nhập, rồi thử đăng game. Dữ liệu được lưu trong `data/gameverse.db`.

## Kiểm tra máy chủ
Mở `http://localhost:3000/api/health`. Nếu thấy `{"status":"ok","service":"GAMEVERSE API"}` là server đã chạy.

## Lưu ý quan trọng
- `localhost` chỉ truy cập được trên máy đang chạy server; website chưa được đưa lên Internet.
- Giai đoạn này lưu thông tin game, chưa upload file HTML/ZIP của game. Không mở hoặc chạy file game do người lạ tải lên nếu chưa có sandbox cô lập.
- SQLite phù hợp để học và chạy thử trên một máy. Khi triển khai công khai nhiều người dùng, cần chuyển sang PostgreSQL, HTTPS, sao lưu, giám sát, cấu hình CORS/CSRF phù hợp và secret quản lý an toàn.
- Cookie `secure` tự bật khi `NODE_ENV=production`, vì vậy môi trường production phải dùng HTTPS.

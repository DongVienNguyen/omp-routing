# Lịch sử thay đổi

## Chưa phát hành

- Thêm [mẫu profile riêng](examples/native-vibe/README.md) cho OMP `/vibe` gốc và Paseo Full Access; không thay đổi extension.
- Chấp nhận OMP bản ổn định từ 19.0.1; kiểm tra API, công cụ và quyền của OMP vẫn áp dụng. Đây không phải cam kết tương thích với mọi bản mới hơn.
- Kiểm tra phiên bản OMP trước khi khôi phục checkpoint. Khi chạy `/routing resume`, kiểm tra lại binding đã lưu theo quyền hiện hành. Hook lồng nhau không được xác lập hoặc kết thúc lời gọi thuộc phiên điều phối.
- Tạm dừng attempt khi OMP từ chối `task`, kể cả khi không trả `tool_result`. Lỗi kết thúc khớp lời gọi cũng có thể làm attempt tạm dừng dù chưa có job nền. Extension không cấp quyền hay tự gọi lại.

## 0.1.3

- Planner có thể khai báo điều kiện tiên quyết bằng `tasks[].dependsOn`, tham chiếu task trước đó theo vị trí (`task-1`, `task-2`, …). Có thể bỏ trường này hoặc dùng `[]` nếu không có phụ thuộc.

## 0.1.2

- Sau dispatch, executor phải dùng đúng `nativeTaskCall.arguments` của attempt. Thêm hoặc đổi trường, dùng schema không nhận diện được hoặc gọi trước khi nhận mẫu đều bị từ chối trước khi tạo worker.

## 0.1.1

- Trên OMP 19.0.1, yêu cầu bị chặn không còn rơi vào chat thường. Profile chưa cấu hình vẫn giữ luồng chat của OMP.

## 0.1.0

- Gói routing cho từng profile, không tự bật trong profile mặc định và không cấp quyền model hay công cụ.

## Nguồn gốc

Hai module trong `runtime/` phát triển tiếp từ bộ điều phối routing nội bộ của dự án. Gói gọi API của [Oh My Pi](https://github.com/can1357/oh-my-pi) do host cung cấp; không kèm mã nguồn hoặc binary OMP.

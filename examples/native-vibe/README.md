# Vibe routing gốc: OMP và Paseo

Mẫu riêng cho Windows, đã thử với **OMP 19.2.1** và **Paseo Desktop 0.17.4**. Không cài extension từ repo này, không sửa OMP/Paseo và không dùng `routing-ca-nhan`. Profile riêng này dùng worker đi kèm OMP; không thay mặc định của OMP hay Paseo.

**Chỉ dùng cho môi trường cá nhân do bạn quản lý.** OMP `yolo` và Paseo **Full Access** bỏ qua bước hỏi duyệt công cụ thông thường; không phải sandbox. Worker có thể dùng quyền của tiến trình OMP. Không dùng với dự án, tệp hoặc prompt không tin cậy. Không tự động chấp thuận hộp thoại an toàn của provider.

## OMP: hợp nhất hai tệp YAML

1. Chạy `omp --version` và `omp --profile vibe-ca-nhan config path` để xác nhận bản OMP và thư mục agent của đúng profile trên máy chạy OMP. Với bố cục mặc định, thư mục là `$HOME/.omp/profiles/vibe-ca-nhan/agent`. Nếu profile đã có cấu hình, sao lưu riêng trước khi sửa. Không dùng profile mặc định.
2. Dùng [omp-config.example.yml](omp-config.example.yml) làm `config.yml` của profile mới. Nếu tệp đã có, chỉ hợp nhất ba khóa dưới `modelRoles` và `tools.approvalMode`; giữ nguyên khóa khác. Đối chiếu trước nếu các khóa đích đã có giá trị khác. Không thêm `task.agentModelOverrides` hay cấu hình model theo từng lời gọi.
3. Dùng [omp-models.example.yml](omp-models.example.yml) làm `models.yml` của profile mới; nếu đã có, chỉ thêm mục `providers.9router` hoặc đối chiếu mục cùng tên, không ghi đè provider khác. Thay `baseUrl` minh họa bằng URL cơ sở HTTPS của 9router mà bạn tin cậy, không thêm khóa vào URL. Endpoint phải phục vụ Chat Completions và có đủ ba model trong mẫu. Đặt khóa qua biến môi trường `VIBE_9ROUTER_API_KEY` cho tài khoản chạy OMP và daemon Paseo; giữ nguyên *tên biến* trong YAML. Mở terminal mới sau khi đặt biến; khởi động lại daemon ở bước Paseo để nhận môi trường mới. Không ghi khóa vào repo, YAML, JSON hay prompt.
4. Kiểm tra catalog với `omp --profile vibe-ca-nhan models`. Mở OMP ở thư mục thử chỉ chứa dữ liệu mẫu: `omp --profile vibe-ca-nhan`. Gõ `/vibe` trong TUI; không cần `--yolo`. Yêu cầu thử: “Dùng một worker fast và một worker good để trả hai chuỗi thử khác nhau. Chờ và báo cả hai kết quả; không dùng tệp hay chạy lệnh.”

## Paseo: thêm profile chọn riêng

1. Dừng việc đang chạy và sao lưu riêng tập tin cấu hình của daemon Paseo (mặc định `$HOME/.paseo/config.json`). Từ [paseo-config.example.json](paseo-config.example.json), thêm mục `agents.providers.omp-vibe-ca-nhan` vào map providers hiện có và nối một phần tử vào mảng `daemon.agentProfiles`. Không thay toàn bộ tệp, mảng hay profile mặc định. Nếu alias hoặc ID đã tồn tại, đối chiếu mục đó trước; không thêm bản trùng hoặc ghi đè cấu hình không liên quan.
2. Trong `command[0]`, thay giá trị mẫu bằng đường dẫn tuyệt đối đến executable OMP 19.2.1 trên máy daemon. Dùng một phần tử JSON cho cả đường dẫn; escape dấu gạch chéo ngược theo cú pháp JSON. Giữ `--profile vibe-ca-nhan`. Paseo tự thêm `--mode rpc-ui --approval-mode yolo` cho **Full Access**; không gắn các cờ này vào mẫu command.
3. Khởi động lại daemon cục bộ, mở phiên mới và chọn **Vibe Routing (Full Access)**; đừng chọn provider OMP gốc hoặc profile khác. Paseo RPC không dùng lệnh TUI `/vibe`. Yêu cầu thử: “Dùng công cụ task tích hợp để giao cho agent sonic và task mỗi agent một chuỗi thử khác nhau. Không chỉ định model hay effort, không dùng tệp hay chạy lệnh. Chờ và báo cả hai kết quả.” Đối chiếu model/effort thực tế của child từ metadata OMP, không chỉ dựa vào lời trả lời của model.

## Kết quả thử đã lược bỏ dữ liệu riêng

| Worker | Agent tích hợp | Model thực tế | Effort |
| --- | --- | --- | --- |
| fast | `sonic` | `9router/code-seek` | `high` |
| good | `task` | `9router/code-sol` | `high` |

Cả hai worker hoàn tất và trả kết quả cho phiên cha trong từng lần thử: OMP TUI dùng `/vibe` với `yolo` trong cấu hình; Paseo dùng `task` qua OMP RPC ở **Full Access**. Không ép model hay effort theo từng lời gọi. Đây chỉ là kiểm tra định tuyến cho hai phiên bản nêu trên, không xác minh quyền cô lập hay tương thích với bản khác.

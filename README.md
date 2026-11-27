# OMP Portable Routing

Extension cho [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi), dành cho **profile cá nhân do bạn quản lý**. Một yêu cầu đi qua ba vai: `planner` lập kế hoạch và kiểm tra kết quả, `executor` điều phối trong phiên chính, `worker` thực thi từng nhiệm vụ qua công cụ `task` tích hợp của OMP. Bạn chọn model cho từng vai và một worker descriptor đã có trong OMP. Có thể dùng cùng model cho cả ba vai; vai trò và quyền vẫn khác nhau.

Không có model, provider, khóa API, worker descriptor hay quyền mặc định đi kèm. Nếu chưa có binding và phiên không có checkpoint routing, extension không đổi chat thường. Khi yêu cầu đi qua hook `input`, routing chặn yêu cầu nếu khởi động routing thất bại. Không dựa vào cơ chế này cho mọi client hoặc mọi đường gửi: nếu yêu cầu chỉ đi qua hook dự phòng `before_agent_start`, OMP có thể tiếp tục chat thường sau khi ghi lỗi. Không gửi dữ liệu thật khi có `HOLD` hoặc chưa kiểm tra đường gửi của client bằng dữ liệu mẫu. Dùng profile riêng chưa cấu hình để chủ động tiếp tục chat thường.

Chỉ cần `/vibe` gốc trong OMP TUI hoặc `task` tích hợp trong Paseo Full Access? Dùng [mẫu profile riêng OMP/Paseo](examples/native-vibe/README.md), không cài extension bên dưới.

## Yêu cầu và mức kiểm chứng

- **OMP bản ổn định từ `19.0.1` trở lên**. Đây là ngưỡng kiểm tra phiên bản, không phải cam kết tương thích với mọi bản mới hơn. Extension dùng API và tool tích hợp của OMP; cấu trúc request, nguồn tool, model thực thi và chính sách quyền vẫn phải khớp.
- **Node.js 22 trở lên** để chạy CLI ngoại tuyến. Extension chạy bên trong OMP; không chạy `node index.mjs` để cài hay khởi động nó.
- **Đã kiểm trên Windows:** kịch bản từ chối `task` ở cổng duyệt tích hợp chạy trên OMP **19.0.1** và **19.1.0** trong môi trường cô lập, không tạo worker hay dispatch lần hai. `/routing-doctor` đã được kiểm riêng trên **19.1.0**. Đây không phải bài thử suy luận thật cho mọi provider, mọi client hoặc mọi hệ điều hành.

## Cài từ GitHub

Gói nguồn có tên `@personal/omp-portable-routing`. Trường `private: true` trong [manifest](package.json) ngăn xuất bản npm; không dùng `npm install` theo tên gói, `npx` hoặc `latest`. Chọn commit hoặc bản phát hành bạn tin cậy và kiểm tra nội dung trước khi nạp. Nếu tải gói nén có công bố SHA-256, đối chiếu digest từ kênh tin cậy trước khi giải nén. Không coi một checksum tự tính là bằng chứng nguồn gốc.

Cài **một** bản trong profile riêng. Hai ví dụ sau dùng `routing-demo` làm tên profile minh họa; đổi thành tên bạn chọn. Chạy `git clone` trong thư mục bạn muốn giữ mã nguồn lâu dài. `plugin link` trỏ vào thư mục đó, không sao chép gói: sau khi rà soát bản muốn dùng, giữ nguyên đường dẫn và nội dung khi còn phiên mở. OMP có thể xóa đích cùng tên khi link. Kiểm tra `plugin list` trong đúng profile **trước** khi link; nếu thấy `@personal/omp-portable-routing` đã có, hoặc OMP đang nạp bridge `runtime-routing.*`, dừng để đối chiếu nguồn đang dùng. Không ghi đè hay nạp song song.

**Windows (PowerShell)**

```powershell
$profileName = 'routing-demo'
git clone https://github.com/DongVienNguyen/omp-routing.git
if ($LASTEXITCODE -ne 0) { throw 'Clone failed' }
Set-Location -LiteralPath 'omp-routing' -ErrorAction Stop
omp --profile $profileName plugin list
if ($LASTEXITCODE -ne 0) { throw 'Plugin list failed' }
```

Chỉ tiếp tục nếu danh sách không có gói cùng tên và đã xác nhận không có bridge cũ được nạp. Rà soát và chọn revision bạn tin cậy, rồi chạy trong cùng thư mục:

```powershell
$packageDir = (Get-Location).Path
omp --profile $profileName plugin link "$packageDir"
if ($LASTEXITCODE -ne 0) { throw 'Plugin link failed' }
omp --profile $profileName plugin list
```

**Linux/macOS (shell POSIX)**

```sh
profile_name='routing-demo'
git clone https://github.com/DongVienNguyen/omp-routing.git && cd omp-routing &&
  omp --profile "$profile_name" plugin list
```

Chỉ tiếp tục nếu danh sách không có gói cùng tên và đã xác nhận không có bridge cũ được nạp. Rà soát và chọn revision bạn tin cậy, rồi chạy trong cùng thư mục:

```sh
package_dir="$(pwd -P)"
omp --profile "$profile_name" plugin link "$package_dir" &&
  omp --profile "$profile_name" plugin list
```

Nếu một bước lỗi, dừng và kiểm tra; không tiếp tục trên thư mục hoặc profile khác. Xem [cơ chế `plugin link` của OMP](https://github.com/can1357/oh-my-pi/blob/f40f335845f0b136453d12fec8d6057011082766/docs/plugin-manager-installer-plumbing.md#link-flow-pluginmanagerlink).

**Cách khác, không dùng `plugin link`:** đặt gói đã kiểm tra trong `<agent-dir>/extensions/omp-portable-routing/`. Bên trong thư mục gói phải có `package.json`, `index.mjs`, `settings.mjs`, `store.mjs` và `runtime/`; giữ `cli.mjs` nếu cần cấu hình ngoại tuyến. Không đặt cả lần cài native lẫn lần cài qua plugin trong vùng OMP có thể nạp. Mở phiên mới sau khi cài. Xem [quy tắc nạp extension](https://github.com/can1357/oh-my-pi/blob/f40f335845f0b136453d12fec8d6057011082766/docs/extension-loading.md).

`<agent-dir>` là **thư mục agent của profile đang dùng**, không phải thư mục repo, thư mục `extensions` hay mặc định của profile khác. Với bố cục OMP mặc định và profile có tên, nó nằm ở `$HOME/.omp/profiles/<tên-profile>/agent` (Windows: `$HOME\.omp\profiles\<tên-profile>\agent`). Root tùy chỉnh hoặc XDG có thể đổi vị trí. Dùng `omp --profile routing-demo config path` để kiểm tra vị trí cấu hình OMP; sau khi nạp extension, `/routing-doctor` cho biết đường dẫn profile hoặc file binding thực tế. Không suy ra đường dẫn chỉ từ ví dụ. Xem [profile OMP](https://github.com/can1357/oh-my-pi/blob/f40f335845f0b136453d12fec8d6057011082766/docs/config-usage.md#profiles).

## Cấu hình và chạy lần đầu

1. Từ thư mục dự án muốn làm việc, mở một phiên TUI mới với `omp --profile routing-demo` (đổi tên cho đúng). Nếu OMP chưa có model, thiết lập nhà cung cấp qua OMP, không qua routing. Có thể xem danh mục với `omp --profile routing-demo models`. Xem [model/role](https://github.com/can1357/oh-my-pi/blob/f40f335845f0b136453d12fec8d6057011082766/docs/models.md) và [xác thực nhà cung cấp](https://github.com/can1357/oh-my-pi/blob/f40f335845f0b136453d12fec8d6057011082766/docs/providers.md) của OMP.
2. Gõ `/routing-setup` khi phiên chính đang rảnh và chưa có luồng routing đang dở. Chọn một model chung hoặc chọn riêng `planner`, `executor`, `worker` trong catalog phiên này. Có thể tham khảo role như `@plan`, nhưng phải xác nhận model cụ thể đã phân giải; không lưu alias, fallback hay effort của role tham khảo. Chọn effort được OMP công bố cho model hoặc **Để OMP chọn**; bỏ effort không có nghĩa là tắt suy luận hay khóa mức suy luận. Chọn đúng descriptor được khám phá, còn bật và không trùng tên. Đọc lại đường dẫn, model và revision trước khi lưu. Hủy hoặc hết thời gian chờ thì không lưu.
3. Mở một phiên mới tại đúng dự án với cùng profile. Chạy `/routing-doctor`. Doctor không gọi model; nó báo đường dẫn, binding/revision và kiểm tra catalog cùng điều kiện quyền hiện tại. Doctor đạt không bảo đảm tool `task` còn bật tại thời điểm chạy, nhà cung cấp sẵn sàng, tài khoản có quyền, quota còn hoặc chi phí nằm trong ngân sách. Khi `HOLD`, không giao việc cho đến khi hiểu và xử lý nguyên nhân.
4. Gửi yêu cầu bình thường trong phiên chính, không gõ tên tool như lệnh slash. Thử trước với yêu cầu nhỏ, chỉ đọc, trên dữ liệu mẫu, chẳng hạn: “Chỉ đọc tệp mẫu và tóm tắt; không sửa, không triển khai. Nêu nguồn bằng chứng và phần chưa kiểm tra.” Routing không cấp quyền chỉ đọc cho worker chỉ vì prompt yêu cầu như vậy; kiểm tra quyền tool thực tế trong OMP.

Paseo hay RPC chỉ là giao diện; binding và quyền thuộc về OMP trên máy chạy daemon. Nếu client không đăng ký lệnh hoặc không hiện menu chọn/xác nhận, đừng gửi `/routing-setup` dưới dạng chat. Dùng TUI hoặc CLI ngoại tuyến trên máy daemon, đúng tài khoản/profile, rồi mở phiên mới. Không coi hỗ trợ TUI là bằng chứng mọi client có cùng giao diện hoặc cơ chế duyệt.

### Quyền OMP tích hợp

Routing cần tool `task` tích hợp đang bật. Để giữ đúng model worker, OMP phải cho phép chọn model theo từng lời gọi `task`: trên OMP 19.0.1, `task.perCallModel` mặc định `off`, `eval` không đủ, cần `on` từ phạm vi operator **đã được ủy quyền**. Model worker còn phải được quyền OMP công nhận: role chat do operator cấu hình, model trên descriptor tin cậy mà OMP chấp nhận, hoặc model cha đủ điều kiện. `task.perCallModelAllow`, nếu có, **chỉ thu hẹp** tập đã được cấp; danh mục model, khóa API, một binding đã lưu, dự án hoặc model giống nhau không tự cấp quyền. Xem [quy tắc per-call model của OMP](https://github.com/can1357/oh-my-pi/blob/f40f335845f0b136453d12fec8d6057011082766/docs/task-agent-discovery.md#per-call-model).

Việc lưu binding không sửa quyền. Dự án không thể tự nâng quyền operator. Quyền chọn model worker, quyền công cụ và phê duyệt ngoại lệ nghiệp vụ là ba việc khác nhau. `/routing approve` không duyệt `task` thay OMP. Nếu thiếu quyền, dừng và hỏi operator chỉ về quyền cần thiết cho model/descriptor và phạm vi công việc; không tắt cổng duyệt, bật Full access hay mở rộng quyền để làm cho doctor đạt.

## Luồng công việc

1. **Lập kế hoạch.** `planner` nộp mục tiêu, nhiệm vụ theo thứ tự, điều kiện kiểm tra và `decisions`. Đưa ràng buộc sẵn có vào `checks`. Chỉ đưa quyết định lớn chưa được phép vào `decisions`, ví dụ thay đổi kiến trúc/phạm vi, thao tác phá hủy, di trú, triển khai production hoặc chi phí đáng kể. Nếu `decisions` rỗng, luồng không chờ phê duyệt kế hoạch chung; chỉ giao việc trong phạm vi đã được người dùng cho phép và vẫn chịu mọi cổng của OMP. Nếu có quyết định, phiên vào `awaiting_approval`: đọc rồi `/routing approve` hoặc `/routing cancel`.
2. **Giao tuần tự.** `executor` chỉ được bind nhiệm vụ `pending` đầu tiên có đủ phụ thuộc `completed`; tối đa một attempt đang hoạt động. `routing_dispatch` chỉ tạo intent và mẫu `nativeTaskCall.arguments`, chưa tạo worker. **Ở request tiếp theo**, `executor` gọi `task` với đúng mẫu gồm `context` và đúng một phần tử `tasks` có `agent`, `solutionSpace`, và `task` (chuỗi) hoặc `steps` (mảng) theo schema OMP nhận diện. Không tự thêm model, tool, tên, schema hoặc đổi nội dung; không gọi cùng request với `routing_dispatch`. Chỉ extension bổ sung selector worker và hợp đồng kết quả sau khi xác minh lời gọi, trước kiểm tra quyền và tạo worker của OMP.
3. **Nhận kết quả.** Extension chỉ ghi nhận kết quả có định danh khớp lời gọi `task` gốc, đúng model worker thực tế (và effort nếu đã ràng buộc), không fallback, dữ liệu strict đúng task/attempt. Với job bất đồng bộ, `executor` có thể dùng `wait` tích hợp với `{}` làm điểm đồng bộ của lời gọi đang theo dõi; bản thân `wait`, thông báo async hoặc một job ID không chứng minh hoàn tất. Không đánh đồng phản hồi lỗi, trạng thái đang chạy, kết quả không xác minh được hay thao tác bên ngoài sổ nhiệm vụ với `completed`.
4. **Sửa cục bộ khi `blocked`.** Chỉ kết quả `blocked` hợp lệ với blocker `local_scope` kích hoạt luồng sửa của `planner`. Giữ nguyên mục tiêu chính, phân công, phụ thuộc và các nhiệm vụ đã xong. Planner nộp các bước sửa cho **đúng task đang chặn**, với revision kế tiếp; nếu có quyết định mới, dùng `/routing approve-repair TASK_ID REVISION` sau khi đọc đúng nội dung/revision, hoặc hủy. Không có quyết định mới thì không cần lệnh duyệt sửa riêng. Sau bàn giao, `executor` gọi `routing_continue_repair` rồi bind một attempt mới cho task đó. Tối đa hai vòng sửa cho mỗi task; lặp nguyên danh sách bước ngay trước hoặc hết ngân sách sẽ tạm dừng. Không chạy lại task đã xong. Lỗi native hoặc từ chối `task` không phải blocker `local_scope`.
5. **Kết thúc.** Khi mọi task `completed`, `planner` trở lại để đối chiếu phạm vi và bằng chứng; nếu còn thiếu thì báo thiếu, không tự tuyên bố hoàn tất. `routing_finish` đánh dấu hoàn thành trong pha `coordination`, rồi phiên vào `done` tại điểm kết thúc lượt hợp lệ. Routing cố trả model/effort ban đầu khi có thể xác minh và không còn attempt chưa giải quyết. Hoàn thành trong sổ routing không chứng minh công việc bên ngoài đã an toàn, đúng hay được triển khai.

Trong các pha đang chạy, phiên chính giới hạn tool theo pha; không gọi trực tiếp các tool native ngoài `task`/`wait` ở pha thực thi. Gửi yêu cầu mới khi routing chưa xong sẽ ghi vào nhật ký để trì hoãn, **không tự chạy lại**. Gửi lại khi phiên đã sẵn sàng hoặc trong phiên mới phù hợp; không gửi lại một thao tác có tác dụng phụ khi chưa kiểm tra thực tế.

### Lệnh dành cho người dùng

Thực hiện trên phiên chính đang sở hữu luồng. Các chữ in hoa dưới đây là giá trị cần thay.

| Lệnh | Khi dùng |
| --- | --- |
| `/routing-setup` | Chọn và lưu binding trong phiên `idle`/`done` đang rảnh, có UI. |
| `/routing-doctor` | Kiểm tra profile, catalog và chính sách hiện tại, không gọi model. |
| `/routing` | Xem trạng thái: loại phiên, quyền sở hữu luồng, pha, generation, bàn giao đang chờ và các quyết định cần duyệt của kế hoạch nếu có. |
| `/routing approve` | Duyệt quyết định của kế hoạch hiện tại ở `awaiting_approval`. Không phải duyệt mọi kế hoạch hay cấp thêm quyền. |
| `/routing approve-repair TASK_ID REVISION` | Duyệt đúng task và revision đang chờ ở `awaitapproval`; không dùng revision file binding. Thông báo duyệt chỉ cho biết lệnh, task và revision, không hiện nội dung quyết định. Đọc các bước sửa và quyết định mới cho đúng revision trước khi duyệt. Nếu chưa thấy nội dung, không duyệt. |
| `/routing cancel` | Tạm dừng routing. Không bảo đảm dừng worker đã khởi chạy, không xóa nhật ký và không hoàn tác tác dụng phụ. |
| `/routing reconcile ATTEMPT_ID` | Ngoại lệ hẹp: ghi nhận attempt **chưa spawn** nếu extension đã ghi đúng lỗi trước spawn trong cùng generation, không có invocation/native ID hay bằng chứng mâu thuẫn. Không đoán ID, không dùng cho `Deny` của OMP hoặc chỉ vì không thấy job. Sau khi đối chiếu, dùng `/routing resume` riêng nếu đủ điều kiện. |
| `/routing resume` | Tiếp tục checkpoint `paused` đủ điều kiện, trong đúng phiên, dựa vào binding đã chụp trong checkpoint. Kiểm lại model, effort, descriptor, chính sách stock và tool `task`; không đọc binding mới để thay model của luồng cũ. Không tự phát lại attempt. |

Nếu mở lại phiên có checkpoint, routing khôi phục ở trạng thái tạm dừng hoặc báo `HOLD` nếu không xác minh được. Đọc `/routing`, đối chiếu tác dụng thực tế rồi chỉ dùng `/routing resume` khi không còn attempt đang chạy hoặc chưa giải quyết. Công việc đã hoàn thành không được phát lại.

**Nếu bấm `Deny` tại cổng OMP:** lời gọi gốc đã bind được giữ trong checkpoint; routing chuyển sang `paused` khi OMP báo từ chối được xác minh cho đúng lời gọi trước khi có worker. Không coi task là xong, không gọi lại `task`, không dùng `reconcile` để đổi quyết định này. `/routing resume` chặn attempt lỗi/chưa giải quyết. Một job đã bắt đầu nhưng chưa xong không phải là `Deny`. Đối chiếu bằng chứng với thao tác thực tế; nếu không thể xác minh, giữ checkpoint để kiểm tra. Chỉ bắt đầu yêu cầu mới trong phiên sạch với phạm vi mới rõ ràng sau khi đã xử lý rủi ro lặp công việc.

### Tool theo pha và dữ liệu đầu vào

Đây là tool cho model trong phiên, **không phải** lệnh terminal hay slash command. Các object không nhận khóa thừa; schema đăng ký trong [lifecycle](runtime/supervised-lifecycle.mjs), điều kiện trạng thái trong [state machine](runtime/supervised-state.mjs).

| Pha / tool | Trường đầu vào |
| --- | --- |
| `planning` · `routing_submit_plan` | `goal`: chuỗi; `tasks`: 1–30 phần tử với `step` (chuỗi), `agent` (tên descriptor đúng binding), `assignee` (literal `worker`), `checks` (mảng chuỗi, ít nhất một), `dependsOn` (tùy chọn, mảng ID task đứng trước; bỏ qua hoặc `[]` nếu không có); `decisions`: mảng chuỗi, có thể `[]`. Không truyền `id`: runtime gán `task-1`, `task-2`, … theo vị trí. Ví dụ task thứ hai chỉ chạy sau task đầu nếu có `"dependsOn": ["task-1"]`. |
| `execution` · `routing_dispatch` | `taskId`: ID nhiệm vụ sẵn sàng; dùng nguyên mẫu `task` trả về từ tool, không dựng mẫu thủ công. |
| `localrepair` · `routing_submit_task_repair` | `taskId`: task bị chặn; `masterId`: ID kế hoạch chính hiện tại; `revision`: số nguyên, revision sửa hiện tại cộng một; `repairId`: chuỗi định danh cho bản sửa (chọn một ID mới); `steps`: mảng 1–30 bước cụ thể; `decisions`: mảng quyết định mới, `[]` nếu không có. |
| `localexec` · `routing_continue_repair` | Object rỗng `{}`; chỉ cho task có revision sửa đã được chấp thuận. |
| `coordination` · `routing_finish` | `summary`: chuỗi; chỉ gọi sau khi đối chiếu bằng chứng và tất cả task đã xong. |

Các trường mô tả có giới hạn 4.000 ký tự mỗi chuỗi. Worker trả dữ liệu strict: JSON không Markdown, không khóa thừa, tối đa 16.000 ký tự. Hai dạng hợp lệ:

- `completed`: `taskId`, `attemptId` (chuỗi sao từ dispatch), `status: "completed"`, `evidence` (chuỗi tối đa 8.000 ký tự). Không có `kind`, `scope`, `missing`.
- `blocked`: cùng trường ID và `evidence`, `status: "blocked"`, `kind: "local_scope"`, `scope` bằng `taskId`, `missing` là chuỗi không trắng, tối đa 4.000 ký tự.

Nếu dùng terminal `yield` của worker, gửi object kết quả trong `{data: ...}`, không phải `yield` lỗi hoặc `yield` một section. Chuỗi do worker tự khai không thay cho metadata native về danh tính thực thi. `evidence` đúng kiểu không bảo đảm nội dung đúng; kiểm tra bằng chứng trước khi dùng kết quả.

## CLI cấu hình ngoại tuyến

Chạy [CLI](cli.mjs) từ thư mục gói bằng `node ./cli.mjs --help`. CLI chỉ tạo/sửa binding trong **agent dir đã tồn tại** và đọc tệp JSON đầu vào, không tra catalog, đăng nhập, gọi suy luận hoặc sửa quyền. Cả `--agent-dir` lẫn `--input` phải là đường dẫn vật lý tuyệt đối; tệp input không quá 16 KiB, UTF-8 JSON, không là symlink/hard link. Dùng giá trị thật đã chọn tại profile của bạn, không sao chép khóa hay URL. Đây là mẫu hình dạng, **không phải cấu hình dùng được nguyên xi**:

```json
{
  "workerAgent": "example-worker",
  "roles": {
    "planner":  { "provider": "example-provider", "id": "example-planner" },
    "executor": { "provider": "example-provider", "id": "example-executor" },
    "worker":   { "provider": "example-provider", "id": "example-model" }
  }
}
```

Cần đủ ba vai, không có khóa khác. `provider` và `id` là hai trường riêng; mỗi giá trị tối đa 256 ký tự. Mỗi đoạn bắt đầu bằng chữ cái ASCII hoặc số; phần còn lại có thể thêm `.`, `_`, `+`, `-`. `id` có thể gồm nhiều đoạn cách nhau bởi `/`; `provider` thì không. Dùng giá trị catalog chính xác, không alias, URL, wildcard, pin `@upstream` hay hậu tố effort trong ID. `workerAgent` là tên descriptor chữ thường, số và gạch ngang, tối đa 80 ký tự, bắt đầu bằng chữ hoặc số. Mỗi vai có thể thêm `effort`: `minimal`, `low`, `medium`, `high`, `xhigh` hoặc `max`, nhưng chỉ khi OMP xác nhận mức đó cho model; nếu không chắc, bỏ trường. Không thêm `schemaVersion` và `revision` vào draft. Xem [schema và giới hạn tệp](store.mjs).

Sau khi lưu draft `bindings.json` ở thư mục hiện tại, chạy `show` và `validate` bên dưới. Ví dụ dùng `omp config path` để lấy đường dẫn từ đúng profile; nếu lệnh lỗi hoặc đường dẫn không khớp profile đã chọn, dừng. **Chỉ chạy `apply` sau khi cả hai bước thành công.** Dùng `0` nếu `show` báo `unconfigured`; nếu đã có binding, thay `0` bằng `record.revision` hiện tại.

**PowerShell**

```powershell
$profileName = 'routing-demo'
$agentDir = omp --profile $profileName config path
if ($LASTEXITCODE -ne 0 -or -not $agentDir) { throw 'Cannot resolve agent directory' }
$inputFile = (Resolve-Path -LiteralPath './bindings.json').Path
node ./cli.mjs show --agent-dir "$agentDir"
node ./cli.mjs validate --agent-dir "$agentDir" --input "$inputFile"
```

Sau khi đối chiếu kết quả và revision:

```powershell
node ./cli.mjs apply --agent-dir "$agentDir" --input "$inputFile" --expected-revision 0
```

**Shell POSIX**

```sh
profile_name='routing-demo'
agent_dir="$(omp --profile "$profile_name" config path)" && test -n "$agent_dir" || exit 1
input_file="$(pwd -P)/bindings.json"
node ./cli.mjs show --agent-dir "$agent_dir"
node ./cli.mjs validate --agent-dir "$agent_dir" --input "$input_file"
```

Sau khi đối chiếu kết quả và revision:

```sh
node ./cli.mjs apply --agent-dir "$agent_dir" --input "$input_file" --expected-revision 0
```

File thực tế: `<agent-dir>/routing/model-bindings.v1.json`. Mỗi lần lưu tăng revision; không dùng lại revision cũ nếu người khác đã ghi. Mở phiên OMP mới và chạy `/routing-doctor` sau khi apply. CLI không đổi binding snapshot của checkpoint.

## Xử lý lỗi và khôi phục

| Dấu hiệu | Hành động |
| --- | --- |
| Không thấy lệnh `/routing-setup` hoặc `/routing-doctor` | Kiểm đúng tên profile, đúng thư mục dự án và phiên mới; kiểm package có `omp.extensions` trong manifest, extension không bị tắt và client hiển thị lệnh/UI. Với `plugin link`, kiểm thư mục nguồn vẫn còn. Thử TUI trước khi kết luận lỗi RPC. |
| `LEGACY_ROUTING_SOURCE_CONFLICT`, `DUPLICATE_ROUTING_SOURCE`, `ROUTING_TOOL_SOURCE_CONFLICT` | Tìm tất cả nguồn discovery của OMP: profile, project và plugin đang bật. Sao lưu, đối chiếu, giữ đúng một nguồn extension; không vá đè bridge cũ. |
| `MODEL_UNAVAILABLE_OR_AMBIGUOUS_*`, `UNSUPPORTED_OR_UNVERIFIED_EFFORT_*`, lỗi worker descriptor | Chạy lại setup với lựa chọn catalog của đúng profile và dự án; kiểm provider, model/effort và descriptor còn khả dụng, duy nhất và không bị tắt. Không sửa binding trong attempt đang chạy. |
| `STOCK_TASK_PER_CALL_MODEL_NOT_ENABLED`, `WORKER_MODEL_NOT_APPROVED_BY_STOCK`, `NATIVE_TOOL_UNAVAILABLE` | Kiểm chính sách operator, descriptor và tool `task`/`wait` tích hợp đúng ngữ cảnh. Không bỏ duyệt, cài tool cùng tên để thay thế hay tự nới quyền. |
| `STOCK_AGENT_MODEL_OVERRIDE_CONFLICT`, `STOCK_RETRY_MODEL_FALLBACK_CONFIGURED`, `STOCK_CONTEXT_PROMOTION_CONFIGURED`, `STOCK_ALTERNATE_COMPACTION_MODEL_CONFIGURED` | Binding cố định không tương thích với override của worker, chuỗi fallback model đang bật hoặc chuyển model do context promotion/compaction. Đối chiếu [kiểm tra preflight](settings.mjs) và phối hợp operator dùng profile phù hợp; không âm thầm đổi model hay chính sách. |
| `ROUTING_NATIVE_TASK_SCHEMA_UNAVAILABLE`, `ROUTING_BOUND_TEMPLATE_NOT_PRESENTED`, `ROUTING_BOUND_TEMPLATE_MISMATCH` | Kiểm OMP/provider có dạng schema được extension nhận diện và executor dùng nguyên mẫu ở request kế tiếp. Không chỉnh thủ công đối số, cấp quyền thêm hay thử dispatch lại khi attempt chưa được đối chiếu. |
| `UNRESOLVED_CHECKPOINT`, checkpoint không hợp lệ/khác phiên/khác phiên bản, ghi checkpoint không rõ kết quả | Dừng. Giữ nhật ký riêng và kiểm tác dụng thực tế trước khi làm tiếp. Extension không tự di trú hoặc replay checkpoint cũ, không cung cấp khôi phục worker tách rời. Không sửa tay checkpoint hoặc dùng cơ chế tự chạy lại của host để vượt `HOLD`. |
| `STALE_BINDINGS_REVISION`, `BINDINGS_DRIFT`, đường dẫn/tệp không an toàn | Đọc lại đúng agent dir và revision; đối chiếu bản sao. Dùng đường dẫn vật lý, không qua symlink/junction; không ép ghi lên dữ liệu đã thay đổi. |

**Tệp binding hỏng:** sao lưu riêng trước khi sửa. Khi `show` báo lỗi JSON/schema kèm `sha256=...`, kiểm tra digest là của **đúng tệp** cần thay; chuẩn bị và validate draft mới. Dùng `apply` với cùng `--agent-dir`, `--input`, `--expected-revision 0` và thêm `--replace-invalid-sha256 DIGEST` (64 ký tự hex thường). Cờ này không dùng được cho bản ghi hợp lệ hay để bỏ qua lỗi an toàn tệp. Nếu crash để lại `.writer.lock`, không có tự dọn khóa: dừng mọi tiến trình ghi ở profile đó, đối chiếu file chính, `.stage-*` và bản sao trước khi người vận hành xử lý khóa mồ côi. Không xóa khóa của tiến trình còn chạy.

## Gỡ, đổi phiên bản hoặc quay lui

1. Ngừng nhận việc mới; đối chiếu worker/attempt chưa xong và tác dụng thực tế. Đóng các phiên OMP dùng gói trước khi sửa file. Sao lưu riêng binding, revision, bản gói đã kiểm và checkpoint nếu cần điều tra. Không chép credential/phiên/checkpoint sang máy khác.
2. Nếu cài bằng `plugin link`, chạy `omp --profile routing-demo plugin uninstall '@personal/omp-portable-routing'` ở **đúng profile** (thay tên minh họa). Nếu cài native, đối chiếu toàn bộ thư mục gói với bản đã cài, rồi di chuyển **chỉ thư mục gói** ra khỏi vùng discovery. Nếu thấy tệp lạ hoặc nội dung đổi, dừng để đối chiếu. Không xóa profile hay thư mục dữ liệu chung.
3. Nếu quay về bản trước, cài duy nhất bản đã kiểm bằng cách tương ứng và mở phiên sạch. Muốn quay lại lựa chọn model cũ, dùng setup hoặc lấy phần `roles` và `workerAgent` từ bản sao đã xác minh để tạo draft rồi áp dụng với **revision hiện tại**. Chỉ đọc checkpoint cũ bằng đúng bản phù hợp trong ngữ cảnh lưu trữ của nó; không trộn state giữa các bản hay gắn sang phiên khác. Kiểm lại bằng `/routing-doctor` sau khi cài lại. Gỡ/cài lại hoặc khôi phục file không hoàn tác lời gọi model, chi phí, thay đổi repo hay việc worker đã làm.

## Bảo mật và giới hạn

- Chỉ dùng mã gói, model và descriptor tin cậy. Extension chạy với tài khoản OMP; không phải sandbox hay biện pháp chống mã khác cùng tài khoản. Phê duyệt không thay thế rà soát phạm vi, quyền tool, tệp và mạng mà worker thực sự có thể truy cập. Đừng dùng cho vận hành production hoặc quản trị nhiều người dùng dựa trên giả định có cơ chế cô lập, khôi phục tự động hay bảo đảm không tác dụng phụ.
- Prompt, dữ liệu dự án và bằng chứng có thể được gửi tới provider theo cách OMP thực thi. Checkpoint trong nhật ký phiên giữ binding, kế hoạch, attempt và bằng chứng; yêu cầu hoãn có thể lưu cả chữ và ảnh. Không nhập bí mật vào binding hoặc prompt. Khi báo lỗi chỉ chia sẻ bản tối giản đã che đường dẫn cá nhân, model riêng, prompt, transcript, khóa, header và dữ liệu khách hàng; không gửi tệp auth hay thư mục profile.
- Tool/approval stock vẫn quyết định điều gì chạy. Không có cam kết giá, quota, nhà cung cấp thay thế, hỗ trợ mọi provider/client, song song nhiều worker, replay sau crash hay di trú checkpoint. Dừng nếu bằng chứng quyền, model hoặc thực thi không nhất quán.

## Sau khi nâng cấp OMP

Dùng profile thử riêng: kiểm phiên chưa cấu hình, chạy `/routing-doctor`, rồi thử một yêu cầu ít rủi ro với cổng duyệt của OMP vẫn bật. Nếu schema của tool/request, quyền hoặc tín hiệu kết thúc khác bản đã kiểm, dừng và điều tra trước khi dùng tiếp.

Điểm đọc mã: [entry extension](index.mjs), [setup/doctor và preflight](settings.mjs), [lưu binding](store.mjs), [CLI](cli.mjs), [hook và công cụ](runtime/supervised-lifecycle.mjs), [chuyển trạng thái và xác thực checkpoint](runtime/supervised-state.mjs).

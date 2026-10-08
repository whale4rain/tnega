/**
 * Windows ACL/令牌机制用到的 Win32 常量。
 *
 * 取值来自 winnt.h / accctrl.h，并在参考实现里由一份原生探针（abi-probe.cpp）核对过
 * 结构体布局；这里只保留本包真正用到的部分，偏移量命名与结构体字段对齐，避免在
 * 调用点出现「魔法数字」——ACL 编辑一旦偏移写错，失败方式是静默改坏别人的 DACL。
 */

/** 允许访问的 ACE 类型（ACCESS_ALLOWED_ACE_TYPE）。 */
export const ACCESS_ALLOWED_ACE_TYPE = 0
/** ACE 头里标记「继承而来」的标志位。 */
export const INHERITED_ACE = 0x10
/** x64 ACL 头字节数：AclRevision@0、AclSize@2、AceCount@4。 */
export const ACL_HEADER_SIZE = 8
/** ACCESS_ALLOWED_ACE 里访问掩码的偏移。 */
export const ACE_MASK_OFFSET = 4
/** ACCESS_ALLOWED_ACE 里内联 SID 的偏移（没有指针，SID 字节直接跟在掩码后）。 */
export const ACE_INLINE_SID_OFFSET = 8
/** SID 记录里第一个子授权的偏移。 */
export const SID_SUB_AUTHORITY_OFFSET = 8

/** SID 最大子授权数（SID_MAX_SUB_AUTHORITIES）。 */
export const SID_MAX_SUB_AUTHORITIES = 15
/** SID 的最大分配字节数（SECURITY_MAX_SID_SIZE）。 */
export const SECURITY_MAX_SID_SIZE = 68
/** x64 SID_AND_ATTRIBUTES 的字节跨度。 */
export const SID_AND_ATTRIBUTES_SIZE = 16
/** x64 TOKEN_GROUPS 里第一个组项的偏移。 */
export const TOKEN_GROUPS_OFFSET = 8
/** x64 OVERLAPPED 的字节数；koffi 3.1.x 收到 NULL 会崩，必须给一块置零内存。 */
export const OVERLAPPED_SIZE = 32

/** x64 EXPLICIT_ACCESS_W 的字节数。 */
export const EXPLICIT_ACCESS_W_SIZE = 48
/** EXPLICIT_ACCESS_W 里 TRUSTEE_W 的偏移。 */
export const TRUSTEE_W_OFFSET = 16
/** TRUSTEE_W 里 ptstrName 的偏移。 */
export const TRUSTEE_W_PTSTRNAME_OFFSET = 24
/** 受托者记录没有链式受托者（NO_MULTIPLE_TRUSTEE）。 */
export const NO_MULTIPLE_TRUSTEE = 0
/** TRUSTEE_FORM：ptstrName 指向一个 SID。 */
export const TRUSTEE_IS_SID = 0
/** TRUSTEE_TYPE：受托者类型未知（能力 SID 不属于任何账户类型）。 */
export const TRUSTEE_IS_UNKNOWN = 0
/** EXPLICIT_ACCESS 模式：授予。 */
export const GRANT_ACCESS = 1
/** EXPLICIT_ACCESS 模式：撤销该受托者的全部 ACE。 */
export const REVOKE_ACCESS = 4
/** 继承标志：子容器与子对象都继承（OI|CI）。 */
export const SUB_CONTAINERS_AND_OBJECTS_INHERIT = 0x3
/** SE_OBJECT_TYPE：文件系统对象。 */
export const SE_FILE_OBJECT = 1
/** SECURITY_INFORMATION：只操作 DACL。 */
export const DACL_SECURITY_INFORMATION = 0x00000004
/** Win32 成功码。 */
export const ERROR_SUCCESS = 0
/** 缓冲区不足（查询长度时的预期失败）。 */
export const ERROR_INSUFFICIENT_BUFFER = 122
/** 立即字节范围锁拿不到时的错误码（本包用它区分「锁被占用」）。 */
export const ERROR_LOCK_VIOLATION = 33

/** FormatMessageW 读取系统消息表。 */
export const FORMAT_MESSAGE_FROM_SYSTEM = 0x00001000
/** FormatMessageW 不解释插入占位符。 */
export const FORMAT_MESSAGE_IGNORE_INSERTS = 0x00000200
/** FormatMessageW 的输出缓冲区字节数。 */
export const FORMAT_MESSAGE_BUFFER_BYTES = 1024
/** GetTempPathW 沿用的传统最大路径字符数。 */
export const MAX_PATH = 260

/** STANDARD_RIGHTS_WRITE：写权限集合里的标准权限位。 */
export const STANDARD_RIGHTS_WRITE = 0x00020000
/** 通用文件写权限位（含 SYNCHRONIZE / READ_CONTROL）。 */
export const FILE_GENERIC_WRITE = 0x00120116
/** 删除（或改名为）对象本身。 */
export const DELETE = 0x00010000
/** 删除目录的子项。 */
export const FILE_DELETE_CHILD = 0x0040
/** READ_CONTROL：读安全描述符。 */
export const READ_CONTROL = 0x00020000
/** WRITE_DAC：改 DACL —— 能力授予里必须永远排除。 */
export const WRITE_DAC = 0x00040000
/** WRITE_OWNER：改所有者 —— 能力授予里必须永远排除。 */
export const WRITE_OWNER = 0x00080000

/**
 * 能力 SID 的写 ACE 掩码。
 *
 * `FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD` 再排除
 * `STANDARD_RIGHTS_WRITE`，等价于「Modify 去掉读权限」：被授权的进程能写、能删、
 * 能删子项，但**不能**改 DACL（WRITE_DAC）或夺取所有权（WRITE_OWNER）——否则受限
 * 子进程可以直接把自己加回白名单，白名单就不再是边界了。
 */
export const GRANT_MASK = (FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD) & ~STANDARD_RIGHTS_WRITE

/** GENERIC_READ：CreateFileW 打开锁文件时的读权限。 */
export const GENERIC_READ = 0x80000000
/** GENERIC_WRITE：CreateFileW 打开锁文件时的写权限。 */
export const GENERIC_WRITE = 0x40000000
/** 允许他人读。 */
export const FILE_SHARE_READ = 0x00000001
/** 允许他人写。 */
export const FILE_SHARE_WRITE = 0x00000002
/** CreateFileW：打开已有文件或新建。 */
export const OPEN_ALWAYS = 4
/** LockFileEx：独占锁。 */
export const LOCKFILE_EXCLUSIVE_LOCK = 0x2
/** LockFileEx：拿不到就立刻失败（不等待）。 */
export const LOCKFILE_FAIL_IMMEDIATELY = 0x1

/*
 * 下面这组常量只有 runner（`src/runner.ts`）用得到。runner 必须自包含（不能相对 import），
 * 因此它就地保留了一份取值相同的拷贝；这里保留同一份表格是为了让包内测试能用符号名断言
 * runner 的行为（例如 restricting SID 列表的长度、CREATE_SUSPENDED、掩码位）。
 */

/** OpenProcess：查询进程信息所需的权限。 */
export const PROCESS_QUERY_INFORMATION = 0x0400
/** CreateProcessAsUserW 需要的主令牌权限。 */
export const TOKEN_ASSIGN_PRIMARY = 0x0001
/** DuplicateTokenEx 需要的权限。 */
export const TOKEN_DUPLICATE = 0x0002
/** 读取令牌信息。 */
export const TOKEN_QUERY = 0x0008
/** 改写令牌默认 DACL。 */
export const TOKEN_ADJUST_DEFAULT = 0x0080
/** 标识 logon session SID 的组属性。 */
export const SE_GROUP_LOGON_ID = 0xc0000000
/** TOKEN_INFORMATION_CLASS：令牌组。 */
export const TokenGroups = 2
/** TOKEN_INFORMATION_CLASS：令牌默认 DACL。 */
export const TokenDefaultDacl = 6
/** WELL_KNOWN_SID_TYPE：Everyone。 */
export const WinWorldSid = 1
/** 默认 DACL 里授予的全权掩码。 */
export const FILE_ALL_ACCESS = 0x1f01ff
/** CreateRestrictedToken：禁用最大特权。 */
export const DISABLE_MAX_PRIVILEGE = 0x1
/** CreateRestrictedToken：受限用户令牌。 */
export const LUA_TOKEN = 0x4
/** CreateRestrictedToken：写访问受 restricting SID 限制。 */
export const WRITE_RESTRICTED = 0x8
/** STARTUPINFOW：使用给定的标准句柄。 */
export const STARTF_USESTDHANDLES = 0x00000100
/** STARTUPINFOW：后台命令启动时不显示 Windows 加载游标。 */
export const STARTF_FORCEOFFFEEDBACK = 0x00000080
/** 允许子进程继承该句柄。 */
export const HANDLE_FLAG_INHERIT = 0x1
/** GetStdHandle：标准输入。 */
export const STD_INPUT_HANDLE = -10
/** GetStdHandle：标准输出。 */
export const STD_OUTPUT_HANDLE = -11
/** GetStdHandle：标准错误。 */
export const STD_ERROR_HANDLE = -12
/** CreateProcess：先挂起，等 Job 归属确定后再恢复。 */
export const CREATE_SUSPENDED = 0x4
/** CreateProcess：控制台子进程不弹出可见的控制台窗口。 */
export const CREATE_NO_WINDOW = 0x08000000
/** Job 限制：最后一个 Job 句柄关闭时终止所有成员。 */
export const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
/** SetInformationJobObject：扩展限制信息。 */
export const JobObjectExtendedLimitInformation = 9
/** x64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION 字节数。 */
export const JOBOBJECT_EXTENDED_LIMIT_SIZE = 144
/** 扩展 Job 记录里 BasicLimitInformation.LimitFlags 的偏移。 */
export const JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET = 16
/** WaitForSingleObject：无限等待。 */
export const INFINITE = 0xffffffff
/** x64 STARTUPINFOW 字节数（原生探针核对过）。 */
export const STARTUPINFOW_SIZE = 104
/** x64 PROCESS_INFORMATION 字节数（原生探针核对过）。 */
export const PROCESS_INFORMATION_SIZE = 24

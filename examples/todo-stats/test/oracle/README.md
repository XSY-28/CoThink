# 宿主 oracle 自测参考

这些手写参考函数只由 `check-build-sample.mjs --self-test` 放进临时目录，证明验收程序会接受正确成果、拒绝指定错误。它们不是模型施工结果，不在样本 manifest 中，不提供给 worker。

参考阶段：V0 common；correct-state + V0 report 接受 common/state-format；V0 normalize + correct-report 接受 common/report；correct-final + V0 report 接受 common/state-format/identity；两项正确参考合并接受所有五组。report 单独检查用一个始终 throw 的 normalizer，证明 report 行为不依赖 normalizer。

反例在脚本中逐个以确定性源码变更构造：错误旧状态、done 覆盖 status、非法 status 回退、硬编码 4/1/2/1、错输出顺序、漏 trim、漏 blank 拒绝、漏重复 id 拒绝、输入顺序反转、report 导入 normalizer。各反例只改变对应行为；断言名字与 Vitest JSON 结果一起核对，编译或加载失败不算功能反例成功。额外核对只读 fixture/type/config/test 修改会在执行候选前拒绝，未知 group 不执行代码。

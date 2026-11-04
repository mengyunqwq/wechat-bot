# 按视觉识别结果重命名表情包（文件名 = 语境标签，空格分隔）
# 保留用户原有的核心语义，补上画面/情绪标签，让机器人挑图更准
$dir = 'D:\微信deepseek\data\stickers\import'
$map = [ordered]@{
  '吃白饭的蓝色大肥鱼.jpg'        = '吃白饭 干饭 端饭 得意 理直气壮 筷子 大肥鱼.jpg'
  '吃白饭的蓝色大肥鱼 没吃饱.jpg' = '没吃饱 空碗 吃白饭 被骂 撒娇 可爱 大肥鱼.jpg'
  '吃饱了.jpg'                    = '吃饱了 吃饱饱 摸肚子 满足 开心 脸红 躺.jpg'
  '饿饿 饭饭.jpg'                 = '饿饿 饭饭 饿了 催饭 流口水 撒娇 吃饭.jpg'
  '电死你.jpg'                    = '电死你 电击 生气 发火 警告 别惹我.jpg'
  '最强.jpg'                      = '最强 厉害 得意 自信 傲娇 牛.jpg'
  '无语.jpg'                      = '无语 呆萌 懵 倒插 荒诞 搞笑.jpg'
  '喜欢小肥鱼.jpg'                = '喜欢 自恋 眨眼 得意 魅力 欠揍 可爱.jpg'
  '小肥鱼太棒了.jpg'              = '太棒了 棒 夸奖 欢呼 开心 抛起来 可爱.jpg'
  'token吃完了.jpg'               = 'token吃完了 没token了 哭了 委屈 空盆 可怜 搞笑.jpg'
  '你也要吃白饭吗.jpg'            = '吃白饭 你也要吃吗 干饭 米饭 电脑前 可爱.jpg'
  '打劫，给我token.jpg'           = '打劫 给我token 要token 欠揍 搞怪 吐舌.jpg'
}

foreach ($old in $map.Keys) {
  $src = Join-Path $dir $old
  $dst = Join-Path $dir $map[$old]
  if (Test-Path -LiteralPath $src) {
    if (Test-Path -LiteralPath $dst) { Write-Output "跳过（目标已存在）: $($map[$old])"; continue }
    Rename-Item -LiteralPath $src -NewName $map[$old]
    Write-Output "改名: $old  →  $($map[$old])"
  } else {
    Write-Output "未找到: $old"
  }
}
Write-Output ''
Write-Output '=== 现在的投递目录 ==='
Get-ChildItem $dir -File | Where-Object { $_.Extension -in '.jpg','.png','.gif','.jpeg','.webp' } | Select-Object Name, @{n='KB';e={[math]::Round($_.Length/1KB)}} | Format-Table -AutoSize

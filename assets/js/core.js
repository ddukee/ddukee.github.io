function renderTimeSpan() {
  var date = new Date();
  var year = date.getFullYear().toString();
  var month = (date.getMonth() + 1).toString();
  var day = date.getDate().toString();
  var hour = date.getHours().toString();
  var min = date.getMinutes().toString();
  var sec = date.getSeconds().toString();
  
  month.length < 2 && (month = '0' + month);
  day.length < 2 && (day = '0' + day);
  hour.length < 2 && (hour = '0' + hour);
  min.length < 2 && (min = '0' + min);
  sec.length < 2 && (sec = '0' + sec);
  
  $("#timeSpan").html(year + "-" + month + "-" + day + " " + hour + ":" + min + ":" + sec);
}

function renderCopyright() {
  var year = new Date().getFullYear();
  $("#copyright").html("2017 - " + year + " ");
}

$(function() {
  renderCopyright();
  renderTimeSpan();
  setInterval(renderTimeSpan, 1000);
})
#include "httplib.h"
#include "http_routes.h"
#include "SendTextMsg.h"
#include "GetSelfProfile.h"
#include "ForwardXMLMsg.h"
#include "SendImageMsg.h"
#include "SendVoiceMsg.h"
#include "SendMoment.h"
#include "QueryDB.h"

void RegisterRoutes(httplib::Server& svr)
{
    Route_SendTextMsg(svr);
    RegisterGetSelfProfile(svr);
    Route_ForwardXMLMsg(svr);
    Route_SendImageMsg(svr);
    Route_SendVoiceMsg(svr);
    Route_SendMoment(svr);
    Route_SendMomentCapture(svr);
    Route_SendMomentBiz(svr);
    Route_SendMomentDispatch(svr);
    Route_SendMomentUi(svr);
    Route_SendMomentBizCall(svr);
    Route_MemScan(svr);
    Route_AutoPost(svr);
    Route_DispatcherProbe(svr);
    Route_TaskSrcProbe(svr);
    Route_XmlProbe(svr);
    Route_MomentInternal(svr);
    Route_PublishEntryProbe(svr);
    Route_SetSvc(svr);
    Route_DraftWriterProbe(svr);
    Route_SilentMoment(svr);
    Route_QueryDB(svr);
}
